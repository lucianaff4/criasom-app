<?php
declare(strict_types=1);
namespace Criasom;

use PDO;
use PDOException;
use RuntimeException;
use Throwable;

/** Local implementation; credentials, delivery transport and HTTP remain outside this class. */
final class PdoPlatformBackend implements PlatformBackend
{
    private AccountService $accounts;
    private PurchaseRepository $purchases;
    private array $policies = [];
    private bool $sqlite;
    private const AREAS = ['study', 'repertoire', 'preferences'];
    private const MAX_STATE = 65536;
    private const MAX_FILE = 8388608;

    public function __construct(private PDO $db, private string $key, array $policies = [], private ?string $privateRoot = null)
    {
        if (strlen($key) !== 32) throw new PlatformProblem(503, 'invalid_backend_configuration');
        $driver = $db->getAttribute(PDO::ATTR_DRIVER_NAME);
        if (!in_array($driver, ['sqlite', 'mysql'], true)) throw new PlatformProblem(503, 'unsupported_database');
        $this->sqlite = $driver === 'sqlite';
        $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        if ($this->sqlite) {
            $db->exec('PRAGMA foreign_keys = ON');
            $db->exec('PRAGMA busy_timeout = 2000'); // Bounded wait for the SQLite writer lock.
        }
        $this->accounts = new AccountService($db, $key);
        $this->purchases = new PurchaseRepository($db);
        foreach ($policies as $policy) {
            if (!is_array($policy) || ($policy['verified'] ?? false) !== true) continue;
            foreach (['product_id', 'offer_code'] as $field)
                if (!is_string($policy[$field] ?? null) || !preg_match('/^[a-zA-Z0-9_-]{1,80}$/D', $policy[$field]))
                    throw new PlatformProblem(503, 'invalid_policy_configuration');
            $index = self::policyKey($policy['product_id'], $policy['offer_code']);
            if (isset($this->policies[$index])) throw new PlatformProblem(503, 'ambiguous_policy_configuration');
            $this->policies[$index] = $policy;
        }
    }

    private static function policyKey(string $product, string $offer): string
    {
        return json_encode([$product, $offer], JSON_THROW_ON_ERROR);
    }

    private function query(string $sql, array $params = []): \PDOStatement
    {
        $query = $this->db->prepare($sql);
        $query->execute($params);
        return $query;
    }

    private function atomic(callable $operation): mixed
    {
        if ($this->db->inTransaction()) throw new PlatformProblem(503, 'backend_busy');
        try {
            $this->db->beginTransaction();
            $result = $operation();
            $this->db->commit();
            return $result;
        } catch (Throwable $error) {
            if ($this->db->inTransaction()) $this->db->rollBack();
            if ($error instanceof PDOException) throw new PlatformProblem(503, 'database_unavailable');
            throw $error;
        }
    }

    public function takeQuota(string $scope, string $bucket, int $limit, int $windowSeconds, int $now): bool
    {
        if (!preg_match('/^[a-z0-9][a-z0-9:_-]{0,79}$/D', $scope) || $bucket === '' || strlen($bucket) > 256
            || $limit < 1 || $windowSeconds < 1 || $now < 0) throw new PlatformProblem(500, 'invalid_quota_configuration');
        $window = intdiv($now, $windowSeconds) * $windowSeconds;
        // Delimit with JSON; the database receives no raw IP, email or requester bucket.
        $hash = hash_hmac('sha256', json_encode(['platform-quota', $scope, $bucket, $windowSeconds, $window], JSON_THROW_ON_ERROR), $this->key);
        return $this->atomic(function () use ($hash, $window, $limit): bool {
            $insert = $this->sqlite
                ? 'INSERT INTO auth_quotas (bucket_hash,window_start,hits) VALUES (?,?,0) ON CONFLICT(bucket_hash) DO NOTHING'
                : 'INSERT INTO auth_quotas (bucket_hash,window_start,hits) VALUES (?,?,0) ON DUPLICATE KEY UPDATE bucket_hash=bucket_hash';
            $this->query($insert, [$hash, $window]);
            return $this->query('UPDATE auth_quotas SET hits=hits+1 WHERE bucket_hash=? AND hits<?', [$hash, $limit])->rowCount() === 1;
        });
    }

    public function session(string $token, int $now): ?array { return $this->accounts->session($token, $now); }
    public function requestCode(string $email, string $binding, string $bucket, int $now): array
    {
        try { return $this->accounts->requestCode($email, $binding, $bucket, $now); }
        catch (RuntimeException $error) {
            if ($error->getMessage() === 'Try again later.') throw new PlatformProblem(429, 'rate_limited');
            if (in_array($error->getMessage(), ['Invalid request.', 'Invalid request bucket.', 'Invalid browser binding.'], true))
                throw new PlatformProblem(400, 'invalid_request');
            throw $error;
        }
    }
    public function confirmCode(string $challengeId, string $code, string $binding, int $now): ?array
    {
        try { return $this->accounts->confirmCode($challengeId, $code, $binding, $now); }
        catch (RuntimeException $error) {
            if ($error->getMessage() === 'Invalid browser binding.') throw new PlatformProblem(400, 'invalid_request');
            throw $error;
        }
    }
    public function logout(string $token, string $csrf, int $now): bool { return $this->accounts->logout($token, $csrf, $now); }

    private function verified(array $user, int $now): array
    {
        if (($user['verified'] ?? false) !== true || !is_string($user['id'] ?? null)
            || !preg_match('/^[a-zA-Z0-9_-]{1,32}$/D', $user['id']) || !is_string($user['email'] ?? null)
            || !filter_var($user['email'], FILTER_VALIDATE_EMAIL)) throw new PlatformProblem(403, 'access_denied');
        $row = $this->query('SELECT id,email,email_verified_at FROM users WHERE id=?', [$user['id']])->fetch(PDO::FETCH_ASSOC);
        if (!$row || $row['email'] !== strtolower($user['email']) || (int)$row['email_verified_at'] <= 0
            || (int)$row['email_verified_at'] > $now) throw new PlatformProblem(403, 'access_denied');
        return ['id' => $row['id'], 'email' => $row['email'], 'verified' => true];
    }

    public function capabilities(array $user, int $now): array
    {
        $grants = $this->purchases->forVerifiedUser($this->verified($user, $now));
        $scopes = [];
        foreach ($grants as $grant) {
            if (!is_array($grant['scopes'] ?? null)) continue;
            foreach ($grant['scopes'] as $scope)
                if (is_string($scope) && AccessPolicy::allowed($grants, $scope, $now)) $scopes[$scope] = true;
        }
        $result = array_keys($scopes);
        sort($result, SORT_STRING);
        return $result;
    }

    private function stateUser(array $user, string $area, int $now): array
    {
        if (!in_array($area, self::AREAS, true)) throw new PlatformProblem(400, 'invalid_area');
        $user = $this->verified($user, $now);
        $grants = $this->purchases->forVerifiedUser($user);
        if (!AccessPolicy::allowed($grants, 'app', $now)
            || ($area === 'repertoire' && !AccessPolicy::allowed($grants, 'repertoire', $now)))
            throw new PlatformProblem(403, 'access_denied');
        return $user;
    }

    private static function decodeState(array $row, string $area): array
    {
        if (strlen($row['data_json']) > self::MAX_STATE || (int)$row['revision'] < 0)
            throw new PlatformProblem(503, 'state_unavailable');
        try { $data = json_decode($row['data_json'], false, 32, JSON_THROW_ON_ERROR); }
        catch (\JsonException) { throw new PlatformProblem(503, 'state_unavailable'); }
        if (!is_array($data) && !($data instanceof \stdClass))
            throw new PlatformProblem(503, 'state_unavailable');
        return ['area' => $area, 'revision' => (int)$row['revision'], 'data' => $data, 'updated_at' => (int)$row['updated_at']];
    }

    public function getState(array $user, string $area, int $now): array
    {
        $user = $this->stateUser($user, $area, $now);
        $row = $this->query('SELECT revision,data_json,updated_at FROM user_state WHERE user_id=? AND area=?', [$user['id'], $area])->fetch(PDO::FETCH_ASSOC);
        return $row ? self::decodeState($row, $area) : ['area' => $area, 'revision' => 0, 'data' => new \stdClass(), 'updated_at' => null];
    }

    public function saveState(array $user, string $area, int $expectedRevision, array|\stdClass $data, int $now): array
    {
        $user = $this->stateUser($user, $area, $now);
        if ($expectedRevision < 0 || $expectedRevision === PHP_INT_MAX) throw new PlatformProblem(400, 'invalid_revision');
        try { $json = json_encode($data, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES, 32); }
        catch (\JsonException) { throw new PlatformProblem(400, 'invalid_state'); }
        if (strlen($json) > self::MAX_STATE) throw new PlatformProblem(413, 'state_too_large');
        try { $normalized = json_decode($json, false, 32, JSON_THROW_ON_ERROR); }
        catch (\JsonException) { throw new PlatformProblem(400, 'invalid_state'); }
        return $this->atomic(function () use ($user, $area, $expectedRevision, $json, $normalized, $now): array {
            // First write obtains the SQLite writer lock too, before any snapshot read.
            $insert = $this->sqlite
                ? 'INSERT INTO user_state (user_id,area,revision,data_json,updated_at) VALUES (?,?,0,?,?) ON CONFLICT(user_id,area) DO NOTHING'
                : 'INSERT INTO user_state (user_id,area,revision,data_json,updated_at) VALUES (?,?,0,?,?) ON DUPLICATE KEY UPDATE revision=revision';
            $this->query($insert, [$user['id'], $area, '{}', $now]);
            $row = $this->query('SELECT revision FROM user_state WHERE user_id=? AND area=?' . ($this->sqlite ? '' : ' FOR UPDATE'), [$user['id'], $area])->fetch(PDO::FETCH_ASSOC);
            if (!$row || (int)$row['revision'] !== $expectedRevision) throw new PlatformProblem(409, 'state_conflict');
            if ($this->query('UPDATE user_state SET revision=revision+1,data_json=?,updated_at=? WHERE user_id=? AND area=? AND revision=?', [$json, $now, $user['id'], $area, $expectedRevision])->rowCount() !== 1)
                throw new PlatformProblem(409, 'state_conflict');
            return ['area' => $area, 'revision' => $expectedRevision + 1, 'data' => $normalized, 'updated_at' => $now];
        });
    }

    public function resource(array $user, string $id, int $now): ?array
    {
        if (!preg_match('/^[a-zA-Z0-9_-]{1,80}$/D', $id)) return null;
        try { $user = $this->verified($user, $now); }
        catch (PlatformProblem $error) { if ($error->status === 403) return null; throw $error; }
        $object = $this->query('SELECT * FROM protected_objects WHERE id=?', [$id])->fetch(PDO::FETCH_ASSOC);
        if (!$object) return null;
        try { $object['required_scopes'] = json_decode($object['required_scopes_json'], true, 16, JSON_THROW_ON_ERROR); }
        catch (\JsonException) { return null; }
        $object['assigned_teacher_ids'] = $this->query('SELECT user_id FROM object_teacher_access WHERE object_id=?', [$id])->fetchAll(PDO::FETCH_COLUMN);
        if (!ResourceGate::allowed($user, $this->purchases->forVerifiedUser($user), $object, $now)) return null;
        if ($object['provider'] !== 'local') throw new PlatformProblem(503, 'provider_unavailable');
        if ($this->privateRoot === null) throw new PlatformProblem(503, 'provider_unavailable');
        try {
            $headers = ResourceGate::headers($object['mime']);
            $path = ResourceGate::localPath($this->privateRoot, $object['storage_key']);
            $size = @filesize($path);
            if ($size === false) throw new PlatformProblem(503, 'resource_unavailable');
            if ($size > self::MAX_FILE) throw new PlatformProblem(413, 'resource_too_large');
            $handle = @fopen($path, 'rb');
            if ($handle === false) throw new PlatformProblem(503, 'resource_unavailable');
            try { $body = @stream_get_contents($handle, self::MAX_FILE + 1); }
            finally { fclose($handle); }
            if ($body === false) throw new PlatformProblem(503, 'resource_unavailable');
            if (strlen($body) > self::MAX_FILE) throw new PlatformProblem(413, 'resource_too_large');
            $headers['Content-Length'] = (string)strlen($body);
            return ['body' => $body, 'headers' => $headers];
        } catch (PlatformProblem $error) { throw $error; }
        catch (Throwable) { throw new PlatformProblem(503, 'resource_unavailable'); }
    }

    public function purchase(array $event, int $now): array
    {
        $policy = [];
        if (is_string($event['product_id'] ?? null) && is_string($event['offer_code'] ?? null))
            $policy = $this->policies[self::policyKey($event['product_id'], $event['offer_code'])] ?? [];
        return $this->purchases->apply($event, $policy, $now);
    }
}
