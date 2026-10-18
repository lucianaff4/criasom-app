<?php
declare(strict_types=1);
require_once __DIR__ . '/../src/AccessPolicy.php';
use Criasom\AccessPolicy as Access;

// Synthetic product/offer IDs only; execute with: php tests/access-policy.php
$checks = 0;
function check(bool $value, string $message): void {
    global $checks;
    ++$checks;
    if (!$value) throw new RuntimeException($message);
}
function event(array $overrides = []): array {
    return array_replace(['event_id' => 'ev-1', 'transaction_id' => 'txn-test-1',
        'occurred_at' => 100, 'type' => 'approved', 'email' => 'student@example.test',
        'product_id' => 'test-product', 'offer_code' => 'test-offer', 'paid_through' => 200], $overrides);
}
function policy(array $overrides = []): array {
    return array_replace(['verified' => true, 'product_id' => 'test-product',
        'offer_code' => 'test-offer', 'duration' => 'paid_through',
        'scopes' => ['app', 'course:dap']], $overrides);
}
$first = Access::reduce(null, event(), policy());
$grant = $first['grant'];
check($first['disposition'] === 'applied', 'approval');
check(Access::allowed([$grant], 'course:dap', 100), 'paid course allowed');
check(!Access::allowed([$grant], 'course:dah', 150), 'other course denied');
check(!Access::allowed([$grant], 'agd:challenges', 150), 'academy denied');
check(!Access::allowed([$grant], 'course:dap', 99), 'not before start');
check(!Access::allowed([$grant], 'course:dap', 200), 'exclusive expiration cutoff');
check(Access::reduce($grant, event(), policy())['disposition'] === 'duplicate', 'duplicate');
$conflict = Access::reduce($grant, event(['paid_through' => 300]), policy());
check($conflict['disposition'] === 'review' && !Access::allowed([$conflict['grant']], 'app', 150), 'same ID conflict quarantined');
$old = Access::reduce($grant, event(['event_id' => 'old', 'occurred_at' => 90, 'type' => 'delayed']), policy());
check($old['disposition'] === 'stale' && $old['grant'] === $grant, 'out of order unchanged');
$refund = Access::reduce($grant, event(['event_id' => 'refund', 'occurred_at' => 90, 'type' => 'refunded']), policy());
check($refund['grant']['status'] === 'revoked', 'old refund still wins');
check(!Access::allowed([$refund['grant']], 'app', 150), 'refunded access denied');
$second = Access::reduce(null, event(['event_id' => 'other', 'transaction_id' => 'txn-test-2']), policy())['grant'];
check(Access::allowed([$refund['grant'], $second], 'course:dap', 150), 'refund preserves independent purchase');
$revive = Access::reduce($refund['grant'], event(['event_id' => 'revive', 'occurred_at' => 120]), policy());
check($revive['disposition'] === 'review' && !Access::allowed([$revive['grant']], 'app', 150), 'refund cannot revive');
$cancel = Access::reduce($grant, event(['event_id' => 'cancel', 'occurred_at' => 120, 'type' => 'canceled', 'paid_through' => null]), policy());
check(Access::allowed([$cancel['grant']], 'app', 199), 'cancellation keeps known paid period');
check(!Access::allowed([$cancel['grant']], 'app', 200), 'cancellation expires naturally');
$renew = Access::reduce($cancel['grant'], event(['event_id' => 'renew', 'occurred_at' => 130, 'paid_through' => 300]), policy());
check($renew['disposition'] === 'review', 'same transaction cannot renew');
$newRenewal = Access::reduce(null, event(['transaction_id' => 'txn-renewal', 'event_id' => 'new-renewal', 'occurred_at' => 180, 'paid_through' => 300]), policy());
check(Access::allowed([$cancel['grant'], $newRenewal['grant']], 'app', 250), 'independent renewal allowed');
$delayed = Access::reduce($grant, event(['event_id' => 'delay', 'occurred_at' => 140, 'type' => 'delayed', 'paid_through' => 500]), policy());
check($delayed['grant']['paid_through'] === 200 && !Access::allowed([$delayed['grant']], 'app', 201), 'delayed does not extend');
$expired = Access::reduce($grant, event(['event_id' => 'expire', 'occurred_at' => 200, 'type' => 'expired']), policy());
check(!Access::allowed([$expired['grant']], 'app', 201), 'explicit expiration');
$onlyCourse = Access::reduce(null, event(), policy(['scopes' => ['course:dap']]))['grant'];
check(!Access::allowed([$onlyCourse], 'course:dap', 150), 'app is not inferred from course');
$onlyAgd = Access::reduce(null, event(), policy(['scopes' => ['agd:challenges']]))['grant'];
check(!Access::allowed([$onlyAgd], 'agd:challenges', 150), 'app is not inferred from AGD');
$app = Access::reduce(null, event(), policy(['scopes' => ['app']]))['grant'];
check(Access::allowed([$app, $onlyAgd], 'agd:challenges', 150), 'explicit separate app and academy');
$repertoire = Access::reduce(null, event(), policy(['scopes' => ['app', 'repertoire']]))['grant'];
check(Access::allowed([$repertoire], 'repertoire', 150), 'repertoire independent of course');
check(!Access::allowed([$repertoire], 'course:dap', 150), 'repertoire does not grant courses');
$lifetime = Access::reduce(null, event(['paid_through' => null]), policy(['duration' => 'lifetime']));
check(Access::allowed([$lifetime['grant']], 'app', 999999999), 'explicit lifetime');
check(Access::reduce(null, event(['paid_through' => null]), policy())['disposition'] === 'review', 'missing paid end fails closed');
check(Access::reduce(null, event(['offer_code' => 'unknown']), policy())['disposition'] === 'review', 'unknown offer');
check(Access::reduce(null, event(['offer_code' => '']), policy())['disposition'] === 'review', 'missing offer');
check(Access::reduce(null, event(), policy(['verified' => false]))['disposition'] === 'review', 'unverified mapping');
check(Access::reduce($grant, event(['event_id' => 'email', 'email' => 'other@example.test']), policy())['disposition'] === 'review', 'immutable buyer email');
check(Access::reduce($grant, event(['event_id' => 'tie', 'type' => 'expired']), policy())['disposition'] === 'review', 'conflicting same timestamp');
$chargeback = Access::reduce($grant, event(['event_id' => 'cb', 'type' => 'chargeback']), policy());
check(!Access::allowed([$chargeback['grant']], 'app', 150), 'chargeback terminal');
$missingDuration = $grant;
unset($missingDuration['duration']);
check(!Access::allowed([$missingDuration], 'app', 150), 'malformed grant denied');
check(!Access::allowed([$grant], 'course:*', 150), 'no wildcard access');
$noApproval = Access::reduce(null, event(['type' => 'delayed']), policy());
check(!Access::allowed([$noApproval['grant']], 'app', 150), 'delayed cannot create access');
$delayAfterCancel = Access::reduce($cancel['grant'], event(['event_id' => 'cancel-delay', 'occurred_at' => 140, 'type' => 'delayed', 'paid_through' => 500]), policy());
check($delayAfterCancel['grant']['state'] === 'canceled' && $delayAfterCancel['grant']['paid_through'] === 200, 'delayed cannot clear cancellation');
check(Access::reduce($delayAfterCancel['grant'], event(['event_id' => 'revive-cancel', 'occurred_at' => 150]), policy())['disposition'] === 'review', 'delayed cannot bypass cancellation guard');
check(Access::reduce(null, event(['type' => 'canceled', 'paid_through' => null]), policy())['disposition'] === 'review', 'cancellation without known period');
$badScopes = array_replace($grant, ['scopes' => 'app']);
check(!Access::allowed([$badScopes], 'app', 150), 'malformed scopes deny without warning');
check(!Access::allowed([], 'app', 150), 'default deny');
echo json_encode(['suite' => 'access-policy', 'passed' => $checks], JSON_THROW_ON_ERROR) . PHP_EOL;
