<?php
declare(strict_types=1);

use Criasom\AccessPolicy;
use Criasom\HotmartEnvelope;
use Criasom\PdoPlatformBackend;
use Criasom\PlatformProblem;
use Criasom\PurchaseRepository;

foreach (['PlatformBackend', 'AccessPolicy', 'AccountService', 'PurchaseRepository', 'ResourceGate', 'PdoPlatformBackend', 'HotmartEnvelope'] as $class)
    require_once __DIR__ . '/../src/' . $class . '.php';
set_error_handler(static function ($severity, $message) { throw new ErrorException($message, 0, $severity); });

// No network, real identities, private runtime configuration or persistent database.
$checks = 0;
function annualCheck(bool $ok, string $name): void {
    global $checks;
    ++$checks;
    if (!$ok) throw new RuntimeException($name);
}
function annualTime(string $date): int {
    return (new DateTimeImmutable($date, new DateTimeZone('America/Sao_Paulo')))->getTimestamp();
}
function annualUser(PDO $db, string $label): array {
    $user = ['id' => substr(hash('sha256', $label), 0, 32), 'email' => $label . '@example.test', 'verified' => true];
    $q = $db->prepare('INSERT INTO users (id,email,email_verified_at,created_at) VALUES (?,?,?,?)');
    $q->execute([$user['id'], $user['email'], annualTime('2020-01-01 00:00:00'), annualTime('2020-01-01 00:00:00')]);
    return $user;
}
function annualRaw(string $id, string $transaction, array $user, int $approvedAt, int $createdAt, string $offer = 'synthetic-black', string $type = 'PURCHASE_APPROVED'): array {
    return ['id' => $id, 'version' => '2.0.0', 'creation_date' => $createdAt * 1000, 'event' => $type,
        'data' => ['product' => ['id' => 'synthetic-criasom'], 'buyer' => ['email' => $user['email']],
            'purchase' => ['transaction' => $transaction, 'offer' => ['code' => $offer], 'approved_date' => $approvedAt * 1000]]];
}
function annualNormalize(array $raw): array {
    return HotmartEnvelope::normalize(json_encode($raw, JSON_THROW_ON_ERROR), 'synthetic-token-only', 'synthetic-token-only');
}
function annualPurchase(PdoPlatformBackend $backend, array $raw, int $receivedAt): array {
    return $backend->purchase(annualNormalize($raw), $receivedAt);
}
function annualSource(PDO $db, string $transaction): array {
    $q = $db->prepare('SELECT state_json FROM purchase_sources WHERE transaction_id=?');
    $q->execute([$transaction]);
    return json_decode($q->fetchColumn(), true, 64, JSON_THROW_ON_ERROR);
}
function annualBenefit(array $grant, string $scope): array {
    foreach ($grant['benefits'] ?? [] as $benefit)
        if (in_array($scope, $benefit['scopes'] ?? [], true)) return $benefit;
    throw new RuntimeException('Missing resolved benefit: ' . $scope);
}
function annualDenied(callable $operation, string $name): void {
    try { $operation(); }
    catch (PlatformProblem $error) { annualCheck($error->status === 403, $name); return; }
    annualCheck(false, $name);
}

$db = new PDO('sqlite::memory:');
$db->exec(file_get_contents(__DIR__ . '/../sql/sqlite.sql'));
$policies = [
    ['verified' => true, 'product_id' => 'synthetic-criasom', 'offer_code' => 'synthetic-black', 'benefits' => [
        ['scopes' => ['course:dap', 'course:dah'], 'duration' => 'lifetime'],
        ['scopes' => ['app'], 'duration' => 'fixed_months', 'months' => 12, 'timezone' => 'America/Sao_Paulo'],
    ]],
    ['verified' => true, 'product_id' => 'synthetic-criasom', 'offer_code' => 'synthetic-app-annual', 'benefits' => [
        ['scopes' => ['app'], 'duration' => 'fixed_months', 'months' => 12, 'timezone' => 'America/Sao_Paulo'],
    ]],
];
$backend = new PdoPlatformBackend($db, random_bytes(32), $policies);
$repository = new PurchaseRepository($db);
$buyer = annualUser($db, 'black-student');
$start = annualTime('2026-11-11 20:30:00');
$end = annualTime('2027-11-11 20:30:00');
$raw = annualRaw('black-approved-1', 'black-transaction-1', $buyer, $start, $start + 300);
$normalized = annualNormalize($raw);
annualCheck($normalized['approved_at'] === $start, 'approval date normalized independently');
annualCheck($normalized['occurred_at'] === $start + 300, 'event creation retained for ordering');
annualCheck(annualPurchase($backend, $raw, $start + 600)['disposition'] === 'applied', 'Black purchase applied through full adapter/backend/repository');
$black = annualSource($db, 'black-transaction-1');
$appBenefit = annualBenefit($black, 'app');
$pentaBenefit = annualBenefit($black, 'course:dap');
$harmoniaBenefit = annualBenefit($black, 'course:dah');
annualCheck($appBenefit['valid_from'] === $start, 'app begins on approval, not delivery');
annualCheck($appBenefit['paid_through'] === $end, 'app ends after twelve calendar months');
annualCheck($pentaBenefit['duration'] === 'lifetime' && $pentaBenefit['paid_through'] === null, 'Penta has no annual deadline');
annualCheck($harmoniaBenefit['duration'] === 'lifetime' && $harmoniaBenefit['paid_through'] === null, 'Harmonia has no annual deadline');
$scopes = $black['scopes']; sort($scopes, SORT_STRING);
annualCheck($scopes === ['app', 'course:dah', 'course:dap'], 'source scope union supports backend capability derivation');
annualCheck($backend->capabilities($buyer, $start - 1) === [], 'no rights before approval');
annualCheck($backend->capabilities($buyer, $start) === ['app', 'course:dah', 'course:dap'], 'rights active at exact approval');
annualCheck($backend->capabilities($buyer, $end - 1) === ['app', 'course:dah', 'course:dap'], 'full access one second before expiration');
annualCheck($backend->capabilities($buyer, $end) === [], 'app access closes at exclusive annual cutoff');
$grants = $repository->forVerifiedUser($buyer);
annualCheck(AccessPolicy::entitled($grants, 'course:dap', $end), 'Penta enrollment survives app expiration');
annualCheck(AccessPolicy::entitled($grants, 'course:dah', annualTime('2046-11-11 20:30:00')), 'Harmonia lifetime enrollment persists far beyond annual term');
annualCheck(!AccessPolicy::entitled($grants, 'app', $end), 'app entitlement expires independently');
annualCheck(!AccessPolicy::allowed($grants, 'course:dap', $end), 'app capability does not bypass expired app membership');
annualCheck(!AccessPolicy::entitled($grants, 'agd:challenges', $start), 'Black course mapping does not invent Academy entitlement');

$saved = $backend->saveState($buyer, 'study', 0, ['minutes' => 27, 'completed' => ['dap:module-5:step-1']], $start + 10);
annualCheck($saved['revision'] === 1, 'study state saved while annual app is active');
annualDenied(fn() => $backend->getState($buyer, 'study', $end), 'expired app cannot read study state');
annualDenied(fn() => $backend->saveState($buyer, 'study', 1, ['minutes' => 0], $end), 'expired app cannot overwrite study state');
$stateRow = $db->query('SELECT revision,data_json FROM user_state')->fetch(PDO::FETCH_ASSOC);
annualCheck((int)$stateRow['revision'] === 1 && json_decode($stateRow['data_json'], true)['minutes'] === 27, 'expiration preserves state instead of deleting it');

annualCheck(annualPurchase($backend, $raw, $start + 900)['disposition'] === 'duplicate', 'same webhook id and body is idempotent');
$redelivery = annualRaw('black-approved-second-id', 'black-transaction-1', $buyer, $start, $start + 3600);
annualPurchase($backend, $redelivery, $start + 7200);
$repeated = annualSource($db, 'black-transaction-1');
annualCheck(annualBenefit($repeated, 'app')['paid_through'] === $end, 'new approval event id does not extend same transaction');
annualCheck(AccessPolicy::entitled([$repeated], 'app', $start + 7200), 'equivalent repeat approval preserves valid app access');
annualCheck((int)$db->query("SELECT count(*) FROM purchase_sources WHERE transaction_id='black-transaction-1'")->fetchColumn() === 1, 'duplicate approvals retain one purchase source');

$renewStart = annualTime('2027-12-01 10:00:00');
$renewEnd = annualTime('2028-12-01 10:00:00');
$renewRaw = annualRaw('annual-renewal-1', 'annual-renewal-transaction', $buyer, $renewStart, $renewStart + 15, 'synthetic-app-annual');
annualCheck(annualPurchase($backend, $renewRaw, $renewStart + 30)['disposition'] === 'applied', 'independent annual app purchase after expiration');
annualCheck($backend->capabilities($buyer, $renewStart) === ['app', 'course:dah', 'course:dap'], 'annual purchase restores access to existing lifetime courses');
$resumed = $backend->getState($buyer, 'study', $renewStart + 1);
annualCheck($resumed['revision'] === 1 && $resumed['data']->minutes === 27 && $resumed['data']->completed === ['dap:module-5:step-1'], 'progress resumes unchanged after annual repurchase');
annualCheck(annualBenefit(annualSource($db, 'annual-renewal-transaction'), 'app')['paid_through'] === $renewEnd, 'new transaction receives its own approval-based twelve months');
annualCheck($backend->capabilities($buyer, $renewEnd) === [], 'renewed annual period also expires exactly');
annualCheck(AccessPolicy::entitled($repository->forVerifiedUser($buyer), 'course:dap', $renewEnd), 'second app expiration still retains original lifetime course');

$appBuyer = annualUser($db, 'app-only-student');
$appRaw = annualRaw('app-only-approved', 'app-only-transaction', $appBuyer, $start, $start + 30, 'synthetic-app-annual');
annualCheck(annualPurchase($backend, $appRaw, $start + 60)['disposition'] === 'applied', 'standalone app annual offer accepted');
annualCheck($backend->capabilities($appBuyer, $start) === ['app'], 'standalone app grants no courses');
$appGrants = $repository->forVerifiedUser($appBuyer);
foreach (['course:dap', 'course:dah', 'agd:challenges', 'agd:mentoring', 'repertoire'] as $scope)
    annualCheck(!AccessPolicy::entitled($appGrants, $scope, $start), 'standalone app does not grant ' . $scope);
annualCheck($backend->getState($appBuyer, 'study', $start)['revision'] === 0, 'standalone app has its own empty progress');
annualDenied(fn() => $backend->getState($appBuyer, 'repertoire', $start), 'standalone app does not silently enable Repertoire');
annualCheck($backend->capabilities($appBuyer, $end) === [], 'standalone app expires after one year');

// Two concurrent purchases retain independent deadlines; no automatic stacking.
$overlapBuyer = annualUser($db, 'overlap-student');
$firstStart = annualTime('2026-11-12 09:00:00');
$firstEnd = annualTime('2027-11-12 09:00:00');
$secondStart = annualTime('2027-01-12 09:00:00');
$secondEnd = annualTime('2028-01-12 09:00:00');
$firstRaw = annualRaw('overlap-black-approval', 'overlap-black', $overlapBuyer, $firstStart, $firstStart + 10);
$secondRaw = annualRaw('overlap-app-approval', 'overlap-app', $overlapBuyer, $secondStart, $secondStart + 10, 'synthetic-app-annual');
annualPurchase($backend, $firstRaw, $firstStart + 20);
annualPurchase($backend, $secondRaw, $secondStart + 20);
annualCheck(annualBenefit(annualSource($db, 'overlap-black'), 'app')['paid_through'] === $firstEnd, 'later app purchase leaves original bonus deadline unchanged');
annualCheck(annualBenefit(annualSource($db, 'overlap-app'), 'app')['paid_through'] === $secondEnd, 'overlapping purchase does not append twelve months to existing deadline');
annualCheck($backend->capabilities($overlapBuyer, $firstEnd) === ['app', 'course:dah', 'course:dap'], 'second app grant bridges expired bonus');
annualCheck($backend->capabilities($overlapBuyer, $secondEnd) === [], 'overlap never grants an unintended stacked second year');
$refundSecond = annualRaw('overlap-app-refund', 'overlap-app', $overlapBuyer, $secondStart, $secondStart + 86400, 'synthetic-app-annual', 'PURCHASE_REFUNDED');
annualPurchase($backend, $refundSecond, $secondStart + 86401);
annualCheck($backend->capabilities($overlapBuyer, $secondStart + 86401) === ['app', 'course:dah', 'course:dap'], 'refunding standalone app preserves active Black bonus and courses');
annualCheck($backend->capabilities($overlapBuyer, $firstEnd) === [], 'refunded overlap cannot bridge original expiration');

// Refunding a course bundle revokes its own lifetime rights, not another purchase.
$refundBlack = annualRaw('original-black-refund', 'black-transaction-1', $buyer, $start, $renewStart + 86400, 'synthetic-black', 'PURCHASE_REFUNDED');
annualPurchase($backend, $refundBlack, $renewStart + 86401);
annualCheck($backend->capabilities($buyer, $renewStart + 86401) === ['app'], 'Black refund leaves independent annual app purchase active');
$postRefund = $repository->forVerifiedUser($buyer);
annualCheck(!AccessPolicy::entitled($postRefund, 'course:dap', $renewStart + 86401), 'Black refund removes only its Penta entitlement');
annualCheck(!AccessPolicy::entitled($postRefund, 'course:dah', $renewStart + 86401), 'Black refund removes only its Harmonia entitlement');
annualCheck($backend->getState($buyer, 'study', $renewStart + 86401)['data']->minutes === 27, 'course refund preserves historical progress');
annualCheck($backend->capabilities($appBuyer, $start + 100) === ['app'], 'another buyer is not affected by refund');

$doubleBlackBuyer = annualUser($db, 'two-black-purchases');
annualPurchase($backend, annualRaw('double-black-a', 'double-black-transaction-a', $doubleBlackBuyer, $start, $start + 10), $start + 20);
annualPurchase($backend, annualRaw('double-black-b', 'double-black-transaction-b', $doubleBlackBuyer, $start + 86400, $start + 86410), $start + 86420);
$chargebackAt = $start + 172800;
annualPurchase($backend, annualRaw('double-black-chargeback-a', 'double-black-transaction-a', $doubleBlackBuyer, $start, $chargebackAt, 'synthetic-black', 'PURCHASE_CHARGEBACK'), $chargebackAt + 1);
$doubleGrants = $repository->forVerifiedUser($doubleBlackBuyer);
annualCheck(!AccessPolicy::entitled([annualSource($db, 'double-black-transaction-a')], 'course:dap', $chargebackAt + 1), 'chargeback revokes course benefits from its own transaction');
annualCheck(!AccessPolicy::entitled([annualSource($db, 'double-black-transaction-a')], 'app', $chargebackAt + 1), 'chargeback also revokes that transaction app benefit');
annualCheck(AccessPolicy::entitled($doubleGrants, 'course:dap', $chargebackAt + 1), 'chargeback preserves same course granted by another valid purchase');
annualCheck($backend->capabilities($doubleBlackBuyer, $chargebackAt + 1) === ['app', 'course:dah', 'course:dap'], 'independent Black transaction remains fully usable after first chargeback');

$changedDateBuyer = annualUser($db, 'changed-approval-date');
annualPurchase($backend, annualRaw('changed-date-first', 'changed-date-transaction', $changedDateBuyer, $start, $start + 10), $start + 20);
$changedResult = annualPurchase($backend, annualRaw('changed-date-second', 'changed-date-transaction', $changedDateBuyer, $start + 86400, $start + 86410), $start + 86420);
annualCheck($changedResult['disposition'] === 'review', 'same transaction with changed approval date cannot silently restart annual clock');
annualCheck($backend->capabilities($changedDateBuyer, $start + 86420) === [], 'conflicting approval date is quarantined pending review');

// Leap day must clamp to February 28, not silently overflow to March 1.
$leapBuyer = annualUser($db, 'leap-student');
$leapStart = annualTime('2024-02-29 23:30:00');
$leapEnd = annualTime('2025-02-28 23:30:00');
$leapRaw = annualRaw('leap-approved', 'leap-transaction', $leapBuyer, $leapStart, $leapStart + 10, 'synthetic-app-annual');
annualPurchase($backend, $leapRaw, $leapStart + 20);
annualCheck(annualBenefit(annualSource($db, 'leap-transaction'), 'app')['paid_through'] === $leapEnd, 'calendar year clamps leap day in Sao Paulo timezone');
annualCheck($backend->capabilities($leapBuyer, $leapEnd - 1) === ['app'] && $backend->capabilities($leapBuyer, $leapEnd) === [], 'leap-year exclusive cutoff is exact');

// Delayed delivery (even after expiration) must never grant a fresh free year.
$lateBuyer = annualUser($db, 'late-student');
$lateCreated = $end + 3600;
$lateRaw = annualRaw('late-approved', 'late-transaction', $lateBuyer, $start, $lateCreated);
annualPurchase($backend, $lateRaw, $lateCreated + 3600);
$lateGrant = annualSource($db, 'late-transaction');
annualCheck(annualBenefit($lateGrant, 'app')['paid_through'] === $end, 'late webhook anchored to purchase approval, not event creation or receipt');
annualCheck($backend->capabilities($lateBuyer, $lateCreated + 3600) === [], 'already-expired bonus remains expired when finally received');
annualCheck(AccessPolicy::entitled($repository->forVerifiedUser($lateBuyer), 'course:dap', $lateCreated + 3600), 'late approval still records lifetime course enrollment');

$unknownBuyer = annualUser($db, 'unknown-offer-student');
$unknownRaw = annualRaw('unknown-approved', 'unknown-transaction', $unknownBuyer, $start, $start + 10, 'not-mapped');
annualCheck(annualPurchase($backend, $unknownRaw, $start + 20)['disposition'] === 'review', 'unknown offer is held for review');
annualCheck($backend->capabilities($unknownBuyer, $start + 20) === [], 'unknown offer fails closed');

foreach (['missing' => null, 'invalid-string' => 'not-a-date', 'zero' => 0, 'future' => ($start + 3600) * 1000] as $case => $approvedDate) {
    $invalidBuyer = annualUser($db, 'invalid-' . $case);
    $invalidRaw = annualRaw('invalid-' . $case, 'invalid-transaction-' . $case, $invalidBuyer, $start, $start + 10);
    if ($approvedDate === null) unset($invalidRaw['data']['purchase']['approved_date']);
    else $invalidRaw['data']['purchase']['approved_date'] = $approvedDate;
    $rejected = false;
    try {
        $result = annualPurchase($backend, $invalidRaw, $start + 20);
        $rejected = $result['disposition'] === 'review';
    } catch (RuntimeException $error) { $rejected = true; }
    annualCheck($rejected, 'invalid approval date rejected or quarantined: ' . $case);
    annualCheck($backend->capabilities($invalidBuyer, $start + 7200) === [], 'invalid approval cannot create future access: ' . $case);
}

echo json_encode(['suite' => 'black-annual-access', 'passed' => $checks,
    'storage' => 'sqlite-memory', 'inputs' => 'synthetic-only',
    'scope' => 'authenticated-envelope/backend/repository, independent benefits, exact calendar expiration, refunds and progress retention',
    'not_exercised' => ['live Hotmart delivery', 'production database concurrency', 'external Club enrollment changes']], JSON_THROW_ON_ERROR) . PHP_EOL;
