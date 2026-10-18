<?php
declare(strict_types=1);
use Criasom\PdoPlatformBackend;
use Criasom\PlatformProblem;

foreach (['PlatformBackend', 'AccessPolicy', 'AccountService', 'PurchaseRepository', 'ResourceGate', 'PdoPlatformBackend'] as $class)
    require_once __DIR__ . '/../src/' . $class . '.php';
set_error_handler(static function ($severity, $message) { throw new ErrorException($message, 0, $severity); });
$checks = 0;
function pdoCheck(bool $ok, string $name): void {
    global $checks;
    ++$checks;
    if (!$ok) throw new RuntimeException($name);
}
function pdoProblem(callable $operation, int $status, string $error, string $name): void {
    try { $operation(); }
    catch (PlatformProblem $problem) {
        pdoCheck($problem->status === $status && $problem->errorId === $error, $name);
        return;
    }
    pdoCheck(false, $name);
}
function pdoEvent(string $id, string $email, array $extra = []): array {
    $event = array_replace(['event_id' => $id, 'transaction_id' => 'txn-' . $id,
        'occurred_at' => 1700000000, 'email' => $email, 'type' => 'approved',
        'product_id' => 'synthetic-product', 'offer_code' => 'synthetic-offer', 'paid_through' => null], $extra);
    $event['payload_hash'] = hash('sha256', json_encode($event, JSON_THROW_ON_ERROR));
    return $event;
}

// Uses only synthetic identities and a disposable local SQLite database; no network.
$db = new PDO('sqlite::memory:');
$db->exec(file_get_contents(__DIR__ . '/../sql/sqlite.sql'));
$key = random_bytes(32);
$now = 1700000000;
$policy = ['verified' => true, 'product_id' => 'synthetic-product', 'offer_code' => 'synthetic-offer',
    'duration' => 'lifetime', 'scopes' => ['app', 'course:penta', 'repertoire']];
$root = __DIR__ . '/pdo-fixtures-' . bin2hex(random_bytes(8));
mkdir($root);
$fixtureFiles = ['book.pdf', 'other.pdf', 'teacher.pdf', 'bad.html', 'large.txt'];
try {
    file_put_contents($root . '/book.pdf', "%PDF-1.4\nsynthetic fixture\n");
    file_put_contents($root . '/other.pdf', "%PDF-1.4\nprivate\n");
    file_put_contents($root . '/teacher.pdf', "%PDF-1.4\nteacher-only\n");
    file_put_contents($root . '/bad.html', '<script>not an allowed MIME</script>');
    file_put_contents($root . '/large.txt', str_repeat('x', 8388609));
    $backend = new PdoPlatformBackend($db, $key, [$policy], $root);
    pdoProblem(fn() => new PdoPlatformBackend($db, 'short'), 503, 'invalid_backend_configuration', 'key size');
    pdoProblem(fn() => new PdoPlatformBackend($db, $key, [$policy, $policy]), 503, 'ambiguous_policy_configuration', 'ambiguous mapping');

    pdoCheck($backend->takeQuota('http:global', 'all', 2, 60, $now), 'global first hit');
    pdoCheck($backend->takeQuota('http:global', 'all', 2, 60, $now), 'global second hit');
    pdoCheck(!$backend->takeQuota('http:global', 'all', 2, 60, $now), 'global quota denied');
    pdoCheck($backend->takeQuota('http:global', 'all', 2, 60, $now + 60), 'quota new window');
    pdoCheck($backend->takeQuota('http:requester', '192.0.2.25', 1, 60, $now), 'requester first hit');
    pdoCheck(!$backend->takeQuota('http:requester', '192.0.2.25', 1, 60, $now), 'requester quota denied');
    $quotaRows = $db->query('SELECT * FROM auth_quotas')->fetchAll(PDO::FETCH_ASSOC);
    pdoCheck(!str_contains(json_encode($quotaRows), '192.0.2.25'), 'raw requester not stored');

    $binding = bin2hex(random_bytes(32));
    $request = $backend->requestCode('Learner@example.test', $binding, 'synthetic-browser', $now);
    pdoCheck(!isset($request['code']), 'request does not return code');
    $q = $db->prepare('SELECT payload_sealed FROM email_outbox WHERE id=?');
    $q->execute([$request['challenge_id']]);
    $sealed = json_decode($q->fetchColumn(), true, 16, JSON_THROW_ON_ERROR);
    $plain = openssl_decrypt(base64_decode($sealed['cipher']), 'aes-256-gcm', $key, OPENSSL_RAW_DATA,
        base64_decode($sealed['nonce']), base64_decode($sealed['tag']), $sealed['aad']);
    $code = json_decode($plain, true, 16, JSON_THROW_ON_ERROR)['code'];
    $login = $backend->confirmCode($request['challenge_id'], $code, $binding, $now + 1);
    pdoCheck($login !== null, 'code confirmation delegated');
    $user = $backend->session($login['cookie_token'], $now + 2);
    pdoCheck($user !== null && $user['verified'] === true, 'verified session delegated');
    pdoCheck($backend->capabilities($user, $now + 2) === [], 'no purchase no capabilities');
    pdoProblem(fn() => $backend->getState($user, 'study', $now + 2), 403, 'access_denied', 'app required');
    $event = pdoEvent('approved', $user['email']);
    pdoCheck($backend->purchase($event, $now + 2)['disposition'] === 'applied', 'exact server mapping');
    pdoCheck($backend->purchase($event, $now + 2)['disposition'] === 'duplicate', 'repository replay');
    pdoCheck($backend->capabilities($user, $now + 2) === ['app', 'course:penta', 'repertoire'], 'sorted explicit capabilities');
    pdoProblem(fn() => $backend->capabilities(array_replace($user, ['email' => 'other@example.test']), $now + 2), 403, 'access_denied', 'identity must match persisted user');

    $initial = $backend->getState($user, 'study', $now + 2);
    pdoCheck($initial['revision'] === 0 && $initial['data'] instanceof stdClass && get_object_vars($initial['data']) === [], 'initial revision zero and empty object');
    $saved = $backend->saveState($user, 'study', 0, ['minutes' => 10, 'note' => 'Prática amanhã'], $now + 3);
    pdoCheck($saved['revision'] === 1, 'first revision one');
    pdoCheck($backend->getState($user, 'study', $now + 4)['data']->note === 'Prática amanhã', 'UTF-8 state persisted');
    pdoProblem(fn() => $backend->saveState($user, 'study', 0, ['minutes' => 99], $now + 4), 409, 'state_conflict', 'stale writer rejected');
    pdoCheck($backend->getState($user, 'study', $now + 4)['data']->minutes === 10, 'conflict does not overwrite');
    pdoCheck($backend->saveState($user, 'study', 1, ['minutes' => 15], $now + 5)['revision'] === 2, 'next revision');
    pdoProblem(fn() => $backend->saveState($user, 'preferences', 5, [], $now + 4), 409, 'state_conflict', 'nonexistent expected revision');
    pdoCheck($backend->getState($user, 'preferences', $now + 4)['revision'] === 0, 'failed first save rolled back');
    pdoProblem(fn() => $backend->getState($user, 'admin', $now + 4), 400, 'invalid_area', 'area whitelist');
    pdoProblem(fn() => $backend->saveState($user, 'study', -1, [], $now + 4), 400, 'invalid_revision', 'negative revision');
    pdoProblem(fn() => $backend->saveState($user, 'study', 2, ['bad' => "\xB1\x31"], $now + 4), 400, 'invalid_state', 'invalid UTF-8 denied');
    pdoCheck($backend->saveState($user, 'preferences', 0, ['x' => str_repeat('x', 65528)], $now + 4)['revision'] === 1, 'exact 64 KiB JSON accepted');
    pdoProblem(fn() => $backend->saveState($user, 'preferences', 1, ['x' => str_repeat('x', 65529)], $now + 4), 413, 'state_too_large', 'state above 64 KiB denied');
    $shapeJson = '{"settings":{},"map":{"0":"x"},"list":[]}';
    $shape = json_decode($shapeJson, false, 32, JSON_THROW_ON_ERROR);
    $shapeSaved = $backend->saveState($user, 'preferences', 1, $shape, $now + 5);
    pdoCheck(json_encode($shapeSaved['data'], JSON_THROW_ON_ERROR) === $shapeJson, 'save response preserves JSON object and list shapes');
    pdoCheck(json_encode($backend->getState($user, 'preferences', $now + 5)['data'], JSON_THROW_ON_ERROR) === $shapeJson, 'database roundtrip preserves empty and numeric-key objects');
    pdoCheck($backend->saveState($user, 'preferences', 2, [], $now + 6)['data'] === [], 'top-level list remains a list');
    pdoCheck($backend->saveState($user, 'repertoire', 0, ['favorites' => ['synthetic-song']], $now + 4)['revision'] === 1, 'repertoire state with explicit permission');

    $bobId = str_repeat('b', 32);
    $q = $db->prepare('INSERT INTO users (id,email,email_verified_at,created_at) VALUES (?,?,?,?)');
    $q->execute([$bobId, 'bob@example.test', $now, $now]);
    $bob = ['id' => $bobId, 'email' => 'bob@example.test', 'verified' => true];
    $appOnlyPolicy = array_replace($policy, ['scopes' => ['app']]);
    $appOnly = new PdoPlatformBackend($db, $key, [$appOnlyPolicy], $root);
    $appOnly->purchase(pdoEvent('bob-app', $bob['email']), $now + 2);
    $bobState = $appOnly->getState($bob, 'study', $now + 4);
    pdoCheck($bobState['data'] instanceof stdClass && get_object_vars($bobState['data']) === [], 'state isolated by user');
    pdoProblem(fn() => $appOnly->getState($bob, 'repertoire', $now + 4), 403, 'access_denied', 'repertoire requires its own permission');
    pdoProblem(fn() => $backend->getState(array_replace($bob, ['verified' => false]), 'study', $now + 4), 403, 'access_denied', 'unverified state denied');
    $unknown = pdoEvent('unknown', $user['email'], ['offer_code' => 'not-configured']);
    pdoCheck($backend->purchase($unknown, $now + 4)['disposition'] === 'review', 'unknown offer stays in review');

    $insertObject = $db->prepare('INSERT INTO protected_objects (id,storage_key,provider,mime,required_scopes_json,visibility,owner_id,status) VALUES (?,?,?,?,?,?,?,?)');
    $insertObject->execute(['book', 'book.pdf', 'local', 'application/pdf', '["course:penta"]', 'course', null, 'active']);
    $insertObject->execute(['private', 'other.pdf', 'local', 'application/pdf', '["app"]', 'self', $bobId, 'active']);
    $insertObject->execute(['teacher', 'teacher.pdf', 'local', 'application/pdf', '["app"]', 'teacher', $bobId, 'active']);
    $insertObject->execute(['remote', 'remote-key', 'external-provider', 'application/pdf', '["app"]', 'community', null, 'active']);
    $insertObject->execute(['bad-mime', 'bad.html', 'local', 'text/html', '["app"]', 'community', null, 'active']);
    $insertObject->execute(['too-large', 'large.txt', 'local', 'text/plain', '["app"]', 'community', null, 'active']);
    $book = $backend->resource($user, 'book', $now + 5);
    pdoCheck($book !== null && str_starts_with($book['body'], '%PDF-1.4'), 'authorized local bytes');
    pdoCheck($book['headers']['Content-Type'] === 'application/pdf' && $book['headers']['Cache-Control'] === 'private, no-store', 'allowed MIME private headers');
    pdoCheck(!isset($book['path']) && !isset($book['storage_key']), 'private path not returned');
    pdoCheck($backend->resource($bob, 'book', $now + 5) === null, 'course resource denied without course');
    pdoCheck($backend->resource($user, 'private', $now + 5) === null, 'other owner private resource denied');
    pdoCheck($backend->resource($bob, 'private', $now + 5) !== null, 'owner resource allowed');
    pdoCheck($backend->resource($user, 'teacher', $now + 5) === null, 'teacher needs stored assignment');
    $q = $db->prepare('INSERT INTO object_teacher_access (object_id,user_id) VALUES (?,?)');
    $q->execute(['teacher', $user['id']]);
    pdoCheck($backend->resource($user, 'teacher', $now + 5) !== null, 'teacher assignment loaded from database');
    pdoCheck($backend->resource($user, '../book', $now + 5) === null, 'invalid resource id denied');
    pdoCheck($backend->resource($user, 'missing', $now + 5) === null, 'missing resource concealed');
    pdoProblem(fn() => $backend->resource($user, 'remote', $now + 5), 503, 'provider_unavailable', 'external media not implemented');
    pdoProblem(fn() => $backend->resource($user, 'bad-mime', $now + 5), 503, 'resource_unavailable', 'MIME whitelist enforced');
    pdoProblem(fn() => $backend->resource($user, 'too-large', $now + 5), 413, 'resource_too_large', '8 MiB file cap');
    $refund = pdoEvent('refund', $user['email'], ['transaction_id' => $event['transaction_id'], 'type' => 'refunded', 'occurred_at' => $now + 10]);
    $backend->purchase($refund, $now + 10);
    pdoCheck($backend->capabilities($user, $now + 11) === [], 'refund removes derived capabilities');
    pdoProblem(fn() => $backend->getState($user, 'study', $now + 11), 403, 'access_denied', 'refund blocks saved data access');
    pdoCheck($backend->resource($user, 'book', $now + 11) === null, 'refund blocks resource');
    pdoCheck($backend->logout($login['cookie_token'], $login['csrf'], $now + 12), 'logout delegated');
    pdoCheck($backend->session($login['cookie_token'], $now + 13) === null, 'logout session unavailable');
    echo json_encode(['suite' => 'pdo-backend', 'passed' => $checks, 'concurrency' => 'not_exercised_by_this_sequential_suite'], JSON_THROW_ON_ERROR) . PHP_EOL;
} finally {
    foreach ($fixtureFiles as $name) if (is_file($root . '/' . $name)) unlink($root . '/' . $name);
    if (is_dir($root)) rmdir($root);
}
