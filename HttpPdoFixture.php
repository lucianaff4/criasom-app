<?php
declare(strict_types=1);

namespace Criasom\Test;

use Criasom\{HttpKernel, HttpRequest, HttpResponse, PdoPlatformBackend};
use PDO;
use RuntimeException;

/** Test-only composition of the real services; no alternative backend or email transport. */
final class HttpPdoFixture
{
    public const ORIGIN = 'https://criasom.example.test';
    private const POLICIES = [
        ['verified' => true, 'product_id' => 'fixture-penta', 'offer_code' => 'fixture-penta-offer', 'duration' => 'lifetime', 'scopes' => ['app', 'course:penta']],
        ['verified' => true, 'product_id' => 'fixture-repertoire', 'offer_code' => 'fixture-repertoire-offer', 'duration' => 'lifetime', 'scopes' => ['app', 'repertoire']],
    ];
    private ?PDO $db = null;
    private ?PdoPlatformBackend $backend = null;
    private ?HttpKernel $kernel = null;
    private string $key;
    private string $hottok;
    private string $root;
    private array $clients = [];
    private int $now = 1700000000;
    private int $connections = 0;

    public function __construct(private bool $forumEnabled = false)
    {
        $this->root = dirname(__DIR__) . '/http-pdo-fixture-' . bin2hex(random_bytes(8));
        $this->key = random_bytes(32);
        $this->hottok = bin2hex(random_bytes(32));
        if (!mkdir($this->root)) throw new RuntimeException('Cannot create test fixture.');
        try {
            if (!mkdir($this->root . '/private')) throw new RuntimeException('Cannot create test fixture.');
            file_put_contents($this->root . '/private/penta.pdf', "%PDF-1.4\nsynthetic-penta\n");
            file_put_contents($this->root . '/private/repertoire.txt', 'synthetic-repertoire');
            file_put_contents($this->root . '/private/agd.txt', 'synthetic-agd');
            file_put_contents($this->root . '/private/private.txt', 'synthetic-private-owner');
            $this->open(true);
        } catch (\Throwable $error) {
            $this->close();
            throw $error;
        }
    }

    private function open(bool $initialize): void
    {
        $this->db = new PDO('sqlite:' . $this->root . '/state.sqlite');
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        if ($initialize) {
            $this->db->exec(file_get_contents(dirname(__DIR__, 2) . '/sql/sqlite.sql'));
            if($this->forumEnabled)$this->db->exec(file_get_contents(dirname(__DIR__, 2).'/sql/forum-sqlite.sql'));
            $q = $this->db->prepare('INSERT INTO protected_objects (id,storage_key,provider,mime,required_scopes_json,visibility,owner_id,status) VALUES (?,?,?,?,?,?,NULL,?)');
            $q->execute(['penta-book', 'penta.pdf', 'local', 'application/pdf', '["course:penta"]', 'course', 'active']);
            $q->execute(['repertoire-notes', 'repertoire.txt', 'local', 'text/plain', '["repertoire"]', 'community', 'active']);
            $q->execute(['agd-challenge', 'agd.txt', 'local', 'text/plain', '["agd:challenges"]', 'community', 'active']);
        }
        $this->backend = new PdoPlatformBackend($this->db, $this->key, self::POLICIES, $this->root . '/private');
        $this->kernel = new HttpKernel($this->backend, self::ORIGIN, $this->key, $this->hottok, $this->forumEnabled ? new \Criasom\ForumService($this->db,$this->backend,json_decode(file_get_contents(dirname(__DIR__,3).'/criasom-app-piloto/dist/data.json'),true)['modules']) : null);
        ++$this->connections;
    }

    public function reopen(): void
    {
        $this->kernel = null;
        $this->backend = null;
        $this->db = null;
        $this->open(false); // No schema recreation, account recreation or state reseeding.
    }

    public function connectionCount(): int { return $this->connections; }

    public function call(string $client, string $method, string $route, array|\stdClass|null $body = null, array $extraHeaders = []): HttpResponse
    {
        if (!isset($this->clients[$client])) {
            $this->clients[$client] = ['cookies' => [], 'csrf' => '', 'ip' => '192.0.2.' . (10 + count($this->clients))];
        }
        $state = $this->clients[$client];
        $headers = ['Sec-Fetch-Site' => 'same-origin'];
        if ($method === 'POST') $headers += ['Content-Type' => 'application/json', 'Origin' => self::ORIGIN, 'X-CSRF-Token' => $state['csrf']];
        $headers = array_replace($headers, $extraHeaders);
        $request = new HttpRequest($method, '/api/v1' . $route, $headers, $state['cookies'],
            $body === null ? '' : json_encode($body, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
            $state['ip'], true);
        $response = $this->kernel->handle($request, ++$this->now);
        foreach ($response->cookies as $cookie) {
            [$name, $value] = explode('=', explode(';', $cookie, 2)[0], 2);
            if ($value === '' || str_contains($cookie, 'Max-Age=0;')) unset($this->clients[$client]['cookies'][$name]);
            else $this->clients[$client]['cookies'][$name] = $value;
        }
        if (str_starts_with($response->headers['Content-Type'] ?? '', 'application/json')) {
            $json = self::json($response);
            if (isset($json->csrf) && is_string($json->csrf)) $this->clients[$client]['csrf'] = $json->csrf;
        }
        return $response;
    }

    public static function json(HttpResponse $response): \stdClass
    {
        $json = json_decode($response->body, false, 32, JSON_THROW_ON_ERROR);
        if (!$json instanceof \stdClass) throw new RuntimeException('Expected JSON object response.');
        return $json;
    }

    /** Only the local harness can decrypt its own synthetic outbox. Never exposed via HTTP. */
    public function syntheticCode(string $challengeId): string
    {
        $q = $this->db->prepare('SELECT payload_sealed FROM email_outbox WHERE id=?');
        $q->execute([$challengeId]);
        $sealed = json_decode($q->fetchColumn(), true, 16, JSON_THROW_ON_ERROR);
        $plain = openssl_decrypt(base64_decode($sealed['cipher']), 'aes-256-gcm', $this->key,
            OPENSSL_RAW_DATA, base64_decode($sealed['nonce']), base64_decode($sealed['tag']), $sealed['aad']);
        if ($plain === false) throw new RuntimeException('Synthetic delivery cannot be opened.');
        return json_decode($plain, true, 16, JSON_THROW_ON_ERROR)['code'];
    }

    public function event(string $id, string $transaction, string $email, string $product, string $event = 'PURCHASE_APPROVED'): array
    {
        return ['id' => $id, 'event' => $event, 'version' => '2.0.0', 'creation_date' => $this->now * 1000,
            'data' => ['buyer' => ['email' => $email], 'product' => ['id' => $product],
                'purchase' => ['transaction' => $transaction, 'offer' => ['code' => $product . '-offer']]]];
    }

    public function deliver(array $event, bool $authorized = true): HttpResponse
    {
        return $this->call('synthetic-hotmart', 'POST', '/webhooks/hotmart', $event,
            ['X-Hotmart-Hottok' => $authorized ? $this->hottok : 'incorrect-test-token']);
    }

    public function seedPrivateResource(string $ownerId): void
    {
        $q = $this->db->prepare('INSERT INTO protected_objects (id,storage_key,provider,mime,required_scopes_json,visibility,owner_id,status) VALUES (?,?,?,?,?,?,?,?)');
        $q->execute(['owner-note', 'private.txt', 'local', 'text/plain', '["app"]', 'self', $ownerId, 'active']);
    }

    public function storedUserCount(): int { return (int)$this->db->query('SELECT COUNT(*) FROM users')->fetchColumn(); }
    public function persistedRevision(string $userId, string $area): int
    {
        $q = $this->db->prepare('SELECT revision FROM user_state WHERE user_id=? AND area=?');
        $q->execute([$userId, $area]);
        return (int)$q->fetchColumn();
    }

    public function close(): void
    {
        $this->kernel = null;
        $this->backend = null;
        $this->db = null;
        foreach (['penta.pdf', 'repertoire.txt', 'agd.txt', 'private.txt'] as $file)
            if (is_file($this->root . '/private/' . $file)) unlink($this->root . '/private/' . $file);
        if (is_dir($this->root . '/private')) rmdir($this->root . '/private');
        foreach (['state.sqlite', 'state.sqlite-journal', 'state.sqlite-wal', 'state.sqlite-shm'] as $file)
            if (is_file($this->root . '/' . $file)) unlink($this->root . '/' . $file);
        if (is_dir($this->root)) rmdir($this->root);
    }
}
