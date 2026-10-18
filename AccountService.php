<?php
declare(strict_types=1);
namespace Criasom;

use PDO;
use RuntimeException;
use Throwable;

/** Candidate domain service. No HTTP endpoint or email transport is enabled. */
final class AccountService
{
    public function __construct(private PDO $db, private string $key)
    {
        if (strlen($key) !== 32) throw new RuntimeException('A private 32-byte application key is required.');
        $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    }

    private function query(string $sql, array $params = []): \PDOStatement
    {
        $q = $this->db->prepare($sql); $q->execute($params); return $q;
    }
    private function digest(string $value): string { return hash_hmac('sha256', $value, $this->key); }
    private function quota(string $key, int $limit, int $now): void
    {
        $window = intdiv($now, 3600) * 3600;
        $hash = $this->digest('quota:'.$key.':'.$window);
        $sql = $this->db->getAttribute(PDO::ATTR_DRIVER_NAME) === 'sqlite'
            ? 'INSERT INTO auth_quotas (bucket_hash,window_start,hits) VALUES (?,?,0) ON CONFLICT(bucket_hash) DO NOTHING'
            : 'INSERT INTO auth_quotas (bucket_hash,window_start,hits) VALUES (?,?,0) ON DUPLICATE KEY UPDATE bucket_hash=bucket_hash';
        $this->query($sql, [$hash,$window]);
        if ($this->query('UPDATE auth_quotas SET hits=hits+1 WHERE bucket_hash=? AND hits<?', [$hash,$limit])->rowCount() !== 1) throw new RuntimeException('Try again later.');
    }
    private function atomic(callable $operation): mixed
    {
        $this->db->beginTransaction();
        try { $result = $operation(); $this->db->commit(); return $result; }
        catch (Throwable $e) { if ($this->db->inTransaction()) $this->db->rollBack(); throw $e; }
    }
    private static function email(string $value): string
    {
        $email = strtolower(trim($value));
        if (strlen($email) > 254 || !filter_var($email, FILTER_VALIDATE_EMAIL)) throw new RuntimeException('Invalid request.');
        return $email; // Do not strip dots, plus suffixes or merge different mailboxes.
    }
    private static function binding(string $value): void
    {
        if (!preg_match('/^[a-f0-9]{64}$/D', $value)) throw new RuntimeException('Invalid browser binding.');
    }

    /** Returns the same public shape for an existing account and a new email. */
    public function requestCode(string $email, string $browserBinding, string $requesterBucket, int $now): array
    {
        $email = self::email($email); self::binding($browserBinding);
        if ($requesterBucket === '' || strlen($requesterBucket) > 128) throw new RuntimeException('Invalid request bucket.');
        $requesterHash = $this->digest('requester:' . $requesterBucket);
        return $this->atomic(function () use ($email, $browserBinding, $requesterHash, $now) {
            // HTTP boundary must also rate-limit globally; this is per-email/requester defense.
            $this->quota('email:'.$email, 3, $now);
            $this->quota('requester:'.$requesterHash, 20, $now);
            $id = bin2hex(random_bytes(16));
            $code = str_pad((string)random_int(0, 99999999), 8, '0', STR_PAD_LEFT);
            $expires = $now + 600;
            $this->query('INSERT INTO auth_challenges (id,email,code_hash,binding_hash,requester_hash,created_at,expires_at,attempts,used_at) VALUES (?,?,?,?,?,?,?,0,NULL)',
                [$id, $email, $this->digest($id . ':' . $code), $this->digest($browserBinding), $requesterHash, $now, $expires]);
            $nonce = random_bytes(12); $tag = '';
            $plain = json_encode(['to'=>$email, 'template'=>'login-code', 'code'=>$code, 'expires_at'=>$expires], JSON_THROW_ON_ERROR);
            $cipher = openssl_encrypt($plain, 'aes-256-gcm', $this->key, OPENSSL_RAW_DATA, $nonce, $tag, $id);
            if ($cipher === false) throw new RuntimeException('Cannot prepare delivery.');
            $sealed = json_encode(['cipher'=>base64_encode($cipher),'nonce'=>base64_encode($nonce),'tag'=>base64_encode($tag),'aad'=>$id], JSON_THROW_ON_ERROR);
            $this->query('INSERT INTO email_outbox (id,idempotency_key,payload_sealed,status,created_at) VALUES (?,?,?,?,?)', [$id, 'auth:'.$id, $sealed, 'pending', $now]);
            return ['accepted'=>true, 'challenge_id'=>$id, 'expires_in'=>600];
        });
    }

    /** Code delivery is required. Caller sets the returned token only in an HttpOnly cookie. */
    public function confirmCode(string $challengeId, string $code, string $browserBinding, int $now): ?array
    {
        self::binding($browserBinding);
        if (!preg_match('/^[a-f0-9]{32}$/D', $challengeId) || !preg_match('/^[0-9]{8}$/D', $code)) return null;
        return $this->atomic(function () use ($challengeId, $code, $browserBinding, $now) {
            $q = $this->query('UPDATE auth_challenges SET attempts = attempts + 1 WHERE id = ? AND binding_hash = ? AND used_at IS NULL AND expires_at > ? AND attempts < 5', [$challengeId, $this->digest($browserBinding), $now]);
            if ($q->rowCount() !== 1) return null;
            $row = $this->query('SELECT * FROM auth_challenges WHERE id = ?', [$challengeId])->fetch(PDO::FETCH_ASSOC);
            if (!$row || !hash_equals($row['code_hash'], $this->digest($challengeId . ':' . $code))) return null;
            if ($this->query('UPDATE auth_challenges SET used_at = ? WHERE id = ? AND used_at IS NULL', [$now, $challengeId])->rowCount() !== 1) return null;
            $insert = $this->db->getAttribute(PDO::ATTR_DRIVER_NAME) === 'sqlite'
                ? 'INSERT INTO users (id,email,email_verified_at,created_at) VALUES (?,?,?,?) ON CONFLICT(email) DO NOTHING'
                : 'INSERT INTO users (id,email,email_verified_at,created_at) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE email=email';
            $this->query($insert, [bin2hex(random_bytes(16)), $row['email'], $now, $now]);
            $currentRead = $this->db->getAttribute(PDO::ATTR_DRIVER_NAME) === 'sqlite' ? '' : ' FOR UPDATE';
            $user = $this->query('SELECT id,email FROM users WHERE email = ?'.$currentRead, [$row['email']])->fetch(PDO::FETCH_ASSOC);
            if (!$user) throw new RuntimeException('Cannot establish account.');
            $token = bin2hex(random_bytes(32)); $csrf = $this->digest('csrf:'.$token);
            $this->query('INSERT INTO sessions (token_hash,user_id,csrf_hash,created_at,expires_at,revoked_at) VALUES (?,?,?,?,?,NULL)', [hash('sha256',$token), $user['id'], hash('sha256',$csrf), $now, $now+43200]);
            return ['user'=>$user, 'cookie_token'=>$token, 'csrf'=>$csrf, 'expires_at'=>$now+43200];
        });
    }

    public function session(string $token, int $now): ?array
    {
        if (!preg_match('/^[a-f0-9]{64}$/D', $token)) return null;
        $row = $this->query('SELECT u.id,u.email,u.email_verified_at,s.csrf_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?', [hash('sha256',$token), $now])->fetch(PDO::FETCH_ASSOC);
        if (!$row || !$row['email_verified_at']) return null;
        return ['id'=>$row['id'],'email'=>$row['email'],'verified'=>true,'csrf'=>$this->digest('csrf:'.$token)];
    }

    public function logout(string $token, string $csrf, int $now): bool
    {
        $session = $this->session($token, $now);
        if (!$session || !hash_equals($session['csrf'], $csrf)) return false;
        $this->query('UPDATE sessions SET revoked_at = ? WHERE token_hash = ?', [$now, hash('sha256',$token)]);
        return true;
    }
}
