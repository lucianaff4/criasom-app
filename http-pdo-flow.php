<?php
declare(strict_types=1);
// Prepared integration suite: real PHP services and a file SQLite database, without a listener or network.
use Criasom\HttpResponse;
use Criasom\Test\HttpPdoFixture;

foreach (['PlatformBackend', 'AccessPolicy', 'AccountService', 'PurchaseRepository', 'ResourceGate', 'HotmartEnvelope', 'PdoPlatformBackend', 'HttpKernel'] as $class)
    require_once __DIR__ . '/../src/' . $class . '.php';
require_once __DIR__ . '/support/HttpPdoFixture.php';
set_error_handler(static function (int $severity, string $message, string $file, int $line): never {
    throw new ErrorException($message, 0, $severity, $file, $line);
});
$checks = [];
function flowCheck(bool $condition, string $name): void {
    global $checks;
    if (!$condition) throw new RuntimeException('Failed: ' . $name);
    $checks[] = $name;
}
function flowStatus(HttpResponse $response, int $expected, string $name): void {
    flowCheck($response->status === $expected, $name . ' [status ' . $expected . ']');
}
function flowLogin(HttpPdoFixture $fixture, string $client, string $email): \stdClass {
    $anonymous = $fixture->call($client, 'GET', '/session');
    flowStatus($anonymous, 200, $client . ': context');
    flowCheck(HttpPdoFixture::json($anonymous)->authenticated === false, $client . ': starts anonymous');
    $request = $fixture->call($client, 'POST', '/auth/request-code', ['email' => $email]);
    flowStatus($request, 202, $client . ': code prepared');
    $requestBody = HttpPdoFixture::json($request);
    flowCheck(!isset($requestBody->code), $client . ': no code in HTTP response');
    $code = $fixture->syntheticCode($requestBody->challenge_id);
    $confirmed = $fixture->call($client, 'POST', '/auth/confirm-code', ['challenge_id' => $requestBody->challenge_id, 'code' => $code]);
    flowStatus($confirmed, 200, $client . ': code confirmed');
    foreach ($confirmed->cookies as $cookie) {
        flowCheck(str_contains($cookie, 'Secure') && str_contains($cookie, 'HttpOnly')
            && str_contains($cookie, 'SameSite=Lax') && str_contains($cookie, 'Path=/'), $client . ': secure cookie attributes');
    }
    flowCheck(!str_contains($confirmed->body, $code), $client . ': code not exposed after confirmation');
    $session = $fixture->call($client, 'GET', '/session');
    flowStatus($session, 200, $client . ': authenticated session');
    flowCheck(HttpPdoFixture::json($session)->authenticated === true, $client . ': authenticated');
    return HttpPdoFixture::json($session);
}

$fixture = new HttpPdoFixture();
try {
    $alice = flowLogin($fixture, 'alice', 'alice@example.test');
    $bob = flowLogin($fixture, 'bob', 'bob@example.test');
    flowCheck($alice->user->id !== $bob->user->id && $fixture->storedUserCount() === 2, 'two separate persisted accounts');
    flowCheck($alice->capabilities === [] && $bob->capabilities === [], 'login alone grants no purchased access');
    flowStatus($fixture->call('alice', 'GET', '/state/study'), 403, 'no purchase denies study');
    flowStatus($fixture->call('guest', 'GET', '/resources/penta-book'), 401, 'anonymous resource denied');

    $penta = $fixture->event('penta-approved', 'penta-primary', 'alice@example.test', 'fixture-penta');
    flowStatus($fixture->deliver($penta, false), 401, 'unauthenticated webhook rejected');
    flowCheck(HttpPdoFixture::json($fixture->call('alice', 'GET', '/session'))->capabilities === [], 'rejected webhook grants nothing');
    $receipt = $fixture->deliver($penta);
    flowStatus($receipt, 200, 'authenticated synthetic purchase committed');
    flowCheck(HttpPdoFixture::json($receipt)->disposition === 'applied', 'purchase applied');
    flowCheck(!str_contains($receipt->body, 'alice@example.test'), 'receipt does not expose buyer identity');
    flowCheck(HttpPdoFixture::json($fixture->deliver($penta))->disposition === 'duplicate', 'webhook replay deduplicated');
    $repertoire = $fixture->event('repertoire-approved', 'repertoire-primary', 'bob@example.test', 'fixture-repertoire');
    flowCheck(HttpPdoFixture::json($fixture->deliver($repertoire))->disposition === 'applied', 'second account independent offer');
    flowCheck(HttpPdoFixture::json($fixture->call('alice', 'GET', '/session'))->capabilities === ['app', 'course:penta'], 'Penta grants exact access');
    flowCheck(HttpPdoFixture::json($fixture->call('bob', 'GET', '/session'))->capabilities === ['app', 'repertoire'], 'Repertoire grants exact access');

    $book = $fixture->call('alice', 'GET', '/resources/penta-book');
    flowStatus($book, 200, 'Penta owner opens protected file');
    flowCheck($book->body === "%PDF-1.4\nsynthetic-penta\n" && $book->headers['Cache-Control'] === 'private, no-store', 'authorized file bytes and no-store headers');
    flowStatus($fixture->call('bob', 'GET', '/resources/penta-book'), 404, 'other offer cannot open Penta');
    flowStatus($fixture->call('alice', 'GET', '/resources/repertoire-notes'), 404, 'Penta does not imply Repertoire');
    flowStatus($fixture->call('bob', 'GET', '/resources/repertoire-notes'), 200, 'Repertoire owner opens own resource');
    flowStatus($fixture->call('alice', 'GET', '/resources/agd-challenge'), 404, 'AGD remains separate from Penta');
    flowStatus($fixture->call('bob', 'GET', '/resources/agd-challenge'), 404, 'AGD remains separate from Repertoire');
    $fixture->seedPrivateResource($alice->user->id);
    flowStatus($fixture->call('alice', 'GET', '/resources/owner-note'), 200, 'owner opens private item');
    flowStatus($fixture->call('bob', 'GET', '/resources/owner-note'), 404, 'other signed-in student cannot open private item');

    $progress = json_decode('{"module":"penta-m05","step":2,"minutes":15,"completed":["first"],"settings":{},"map":{"0":"x"}}', false, 32, JSON_THROW_ON_ERROR);
    flowStatus($fixture->call('alice', 'POST', '/state/study', ['expected_revision' => 0, 'data' => $progress], ['X-CSRF-Token' => 'wrong']), 403, 'wrong CSRF cannot save progress');
    $saved = $fixture->call('alice', 'POST', '/state/study', ['expected_revision' => 0, 'data' => $progress]);
    flowStatus($saved, 200, 'progress saved through HTTP kernel');
    flowCheck(HttpPdoFixture::json($saved)->revision === 1, 'first committed revision is one');
    flowCheck($fixture->persistedRevision($alice->user->id, 'study') === 1, 'revision exists in actual SQLite file');
    $stale = $fixture->call('alice', 'POST', '/state/study', ['expected_revision' => 0, 'data' => ['step' => 99]]);
    flowStatus($stale, 409, 'stale writer cannot replace progress');
    $cross = $fixture->call('bob', 'POST', '/state/study', ['expected_revision' => 0, 'data' => ['step' => 88], 'user_id' => $alice->user->id]);
    flowStatus($cross, 400, 'client cannot select a different state owner');
    $bobState = HttpPdoFixture::json($fixture->call('bob', 'GET', '/state/study'));
    flowCheck($bobState->revision === 0 && $bobState->data instanceof stdClass && get_object_vars($bobState->data) === [], 'second account cannot see first progress');
    flowStatus($fixture->call('bob', 'POST', '/state/study', ['expected_revision' => 0, 'data' => ['minutes' => 5, 'note' => 'Meu treino']]), 200, 'second account saves independent progress');
    flowStatus($fixture->call('alice', 'GET', '/state/repertoire'), 403, 'Repertoire progress requires entitlement');
    flowStatus($fixture->call('bob', 'POST', '/state/repertoire', ['expected_revision' => 0, 'data' => ['favorites' => ['fixture-song']]]), 200, 'authorized Repertoire favorites saved');

    $fixture->reopen();
    flowCheck($fixture->connectionCount() === 2, 'new PDO backend and kernel instantiated over same file');
    $afterAlice = HttpPdoFixture::json($fixture->call('alice', 'GET', '/session'));
    $afterBob = HttpPdoFixture::json($fixture->call('bob', 'GET', '/session'));
    flowCheck($afterAlice->authenticated && $afterAlice->user->id === $alice->user->id, 'Alice session survives backend reopening');
    flowCheck($afterBob->authenticated && $afterBob->user->id === $bob->user->id, 'Bob session survives backend reopening');
    flowCheck($fixture->storedUserCount() === 2, 'reopening does not recreate accounts');
    $restored = HttpPdoFixture::json($fixture->call('alice', 'GET', '/state/study'));
    flowCheck($restored->revision === 1 && json_encode($restored->data) === json_encode($progress), 'progress and JSON object shapes survive actual database reopening');
    flowCheck(HttpPdoFixture::json($fixture->call('bob', 'GET', '/state/study'))->data->minutes === 5, 'other progress remains isolated after reopening');
    flowCheck(HttpPdoFixture::json($fixture->call('bob', 'GET', '/state/repertoire'))->data->favorites === ['fixture-song'], 'favorites survive reopening');
    flowStatus($fixture->call('alice', 'POST', '/state/study', ['expected_revision' => 1, 'data' => ['module' => 'penta-m05', 'step' => 3]]), 200, 'resumed session can continue study');
    flowCheck($fixture->persistedRevision($alice->user->id, 'study') === 2, 'resumed update advances revision');

    $secondPenta = $fixture->event('penta-extra-approved', 'penta-independent', 'alice@example.test', 'fixture-penta');
    flowCheck(HttpPdoFixture::json($fixture->deliver($secondPenta))->disposition === 'applied', 'independent purchase of same course');
    $refund = $fixture->event('penta-refunded', 'penta-primary', 'alice@example.test', 'fixture-penta', 'PURCHASE_REFUNDED');
    flowCheck(HttpPdoFixture::json($fixture->deliver($refund))->disposition === 'applied', 'first purchase refunded');
    flowStatus($fixture->call('alice', 'GET', '/resources/penta-book'), 200, 'independent purchase survives first refund');
    $secondRefund = $fixture->event('penta-extra-refunded', 'penta-independent', 'alice@example.test', 'fixture-penta', 'PURCHASE_REFUNDED');
    flowCheck(HttpPdoFixture::json($fixture->deliver($secondRefund))->disposition === 'applied', 'remaining purchase refunded');
    $revoked = HttpPdoFixture::json($fixture->call('alice', 'GET', '/session'));
    flowCheck($revoked->authenticated === true && $revoked->capabilities === [], 'refund revokes access without falsifying login state');
    flowStatus($fixture->call('alice', 'GET', '/resources/penta-book'), 404, 'refunded account cannot open protected file');
    flowStatus($fixture->call('alice', 'GET', '/state/study'), 403, 'refunded app access cannot read saved progress');
    flowCheck($fixture->persistedRevision($alice->user->id, 'study') === 2, 'refund preserves historical progress instead of erasing it');
    flowStatus($fixture->call('bob', 'GET', '/resources/repertoire-notes'), 200, 'other student unaffected by refunds');
    flowCheck(HttpPdoFixture::json($fixture->call('bob', 'GET', '/state/repertoire'))->data->favorites === ['fixture-song'], 'other student favorites unaffected');

    flowStatus($fixture->call('bob', 'POST', '/auth/logout', new stdClass()), 200, 'logout committed');
    $fixture->reopen();
    flowCheck(HttpPdoFixture::json($fixture->call('bob', 'GET', '/session'))->authenticated === false, 'logout remains effective after another reopening');
    flowStatus($fixture->call('bob', 'GET', '/state/repertoire'), 401, 'signed-out client cannot read favorites');
    echo json_encode(['suite' => 'http-pdo-flow', 'passed' => count($checks), 'checks' => $checks,
        'real_components' => ['HttpKernel', 'PdoPlatformBackend', 'AccountService', 'PurchaseRepository', 'AccessPolicy', 'ResourceGate', 'SQLite file'],
        'limitations' => ['In-process HTTP requests; no network listener or browser.', 'Synthetic purchases and local outbox decryption only; no real provider.', 'Sequential scenario; simultaneous database races not exercised.']],
        JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE) . PHP_EOL;
} finally {
    $fixture->close();
}
