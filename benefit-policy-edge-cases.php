<?php
declare(strict_types=1);

require_once __DIR__ . '/../src/AccessPolicy.php';
use Criasom\AccessPolicy as Access;

set_error_handler(static function ($severity, $message) { throw new ErrorException($message, 0, $severity); });
$checks = 0;
function edgeCheck(bool $ok, string $label): void {
    global $checks;
    ++$checks;
    if (!$ok) throw new RuntimeException($label);
}
function edgeEvent(array $changes = []): array {
    $start = (new DateTimeImmutable('2026-11-11T20:30:00-03:00'))->getTimestamp();
    return array_replace(['event_id'=>'edge-approval', 'transaction_id'=>'edge-purchase',
        'email'=>'edge-student@example.test', 'product_id'=>'TESTE-black', 'offer_code'=>'TESTE-offer',
        'occurred_at'=>$start + 10, 'approved_at'=>$start, 'type'=>'approved', 'paid_through'=>null], $changes);
}
function edgePolicy(array $changes = []): array {
    return array_replace(['verified'=>true, 'product_id'=>'TESTE-black', 'offer_code'=>'TESTE-offer',
        'benefits'=>[
            ['duration'=>'lifetime', 'scopes'=>['course:penta', 'course:harmonia']],
            ['duration'=>'fixed_months', 'scopes'=>['app'], 'months'=>12, 'timezone'=>'America/Sao_Paulo'],
        ]], $changes);
}
function edgeAppEnd(array $grant): int {
    foreach ($grant['benefits'] ?? [] as $benefit)
        if (in_array('app', $benefit['scopes'] ?? [], true)) return $benefit['paid_through'];
    throw new RuntimeException('Missing app benefit');
}
function edgeReviewDenied(array $result, string $label, int $now): void {
    edgeCheck($result['disposition'] === 'review', $label . ': review');
    edgeCheck(!Access::allowed([$result['grant']], 'app', $now), $label . ': app denied');
    edgeCheck(!Access::entitled([$result['grant']], 'course:penta', $now), $label . ': courses quarantined');
}

$event = edgeEvent();
$start = $event['approved_at'];
$end = (new DateTimeImmutable('2027-11-11T20:30:00-03:00'))->getTimestamp();
$policy = edgePolicy();
$grant = Access::reduce(null, $event, $policy)['grant'];
edgeCheck(Access::allowed([$grant], 'course:penta', $start), 'baseline grants course while app active');

// A refund received first reserves the source as terminal; later approval cannot revive it.
$refunded = Access::reduce(null, edgeEvent(['event_id'=>'edge-refund-first', 'type'=>'refunded', 'occurred_at'=>$start+50]), $policy);
edgeCheck($refunded['disposition'] === 'applied' && $refunded['grant']['status'] === 'revoked', 'refund first records terminal source');
edgeCheck(!Access::entitled([$refunded['grant']], 'course:penta', $start+60), 'refund first grants no lifetime course');
$revive = Access::reduce($refunded['grant'], edgeEvent(['event_id'=>'edge-revive', 'occurred_at'=>$start+70]), $policy);
edgeReviewDenied($revive, 'later approval cannot revive refund', $start+80);
$oldApproval = Access::reduce($refunded['grant'], $event, $policy);
edgeCheck($oldApproval['disposition'] === 'stale' && $oldApproval['grant']['status'] === 'revoked', 'older approval leaves first refund terminal');

// Late processing stores the original benefit dates; it does not mint a fresh year.
$late = Access::reduce(null, edgeEvent(['occurred_at'=>$end+86400]), $policy)['grant'];
edgeCheck(edgeAppEnd($late) === $end, 'late approval uses purchase date');
edgeCheck(!Access::entitled([$late], 'app', $end+86400), 'late approval app already expired');
edgeCheck(Access::entitled([$late], 'course:penta', $end+86400), 'late approval keeps lifetime course entitlement');

// Equivalent ordering is not a commercial mapping change.
$reordered = $policy;
$reordered['benefits'][0]['scopes'] = array_reverse($reordered['benefits'][0]['scopes']);
$reordered['benefits'] = array_reverse($reordered['benefits']);
$equivalent = Access::reduce($grant, edgeEvent(['event_id'=>'edge-equivalent', 'occurred_at'=>$start+20]), $reordered);
edgeCheck($equivalent['disposition'] === 'applied', 'canonical policy ignores benefit and scope ordering');
edgeCheck($equivalent['grant']['benefit_policy'] === $grant['benefit_policy'], 'canonical definitions remain identical');
edgeCheck($equivalent['grant']['benefits'] === $grant['benefits'], 'equivalent policy leaves resolved benefits identical');

foreach (['months', 'timezone', 'course'] as $change) {
    $changed = $policy;
    if ($change === 'months') $changed['benefits'][1]['months'] = 24;
    elseif ($change === 'timezone') $changed['benefits'][1]['timezone'] = 'UTC';
    else $changed['benefits'][0]['scopes'][] = 'course:new-course';
    edgeReviewDenied(Access::reduce($grant, edgeEvent(['event_id'=>'edge-change-'.$change, 'occurred_at'=>$start+25]), $changed), 'mapping change '.$change, $start+30);
}

// Neither removal of the new mapping nor malformed stored benefits unlock parent lifetime app.
$legacy = ['verified'=>true, 'product_id'=>'TESTE-black', 'offer_code'=>'TESTE-offer',
    'duration'=>'lifetime', 'scopes'=>['app', 'course:penta', 'course:harmonia']];
edgeReviewDenied(Access::reduce($grant, edgeEvent(['event_id'=>'edge-downgrade', 'occurred_at'=>$start+30]), $legacy), 'mixed cannot be downgraded to legacy lifetime', $start+40);
foreach ([null, false, 'app', [], [['duration'=>'lifetime', 'scopes'=>['app'], 'valid_from'=>$start]]] as $index=>$broken) {
    $malformed = $grant;
    $malformed['benefits'] = $broken;
    edgeCheck(!Access::allowed([$malformed], 'app', $start+100), 'malformed benefits never use parent lifetime '.$index);
}

// Many legitimate notifications retain one anchor and deadline even after expiration.
$repeat = $grant;
foreach ([$start+30, $start+3600, $end+1] as $index=>$created) {
    $result = Access::reduce($repeat, edgeEvent(['event_id'=>'edge-repeat-'.$index, 'occurred_at'=>$created]), $policy);
    edgeCheck($result['disposition'] === 'applied', 'repeat approval accepted '.$index);
    $repeat = $result['grant'];
    edgeCheck($repeat['approved_at'] === $start && edgeAppEnd($repeat) === $end, 'repeat cannot extend approval anchor '.$index);
}
edgeCheck(!Access::allowed([$repeat], 'app', $end+1), 'repeat after expiration stays expired');
edgeReviewDenied(Access::reduce($grant, edgeEvent(['event_id'=>'edge-new-anchor', 'approved_at'=>$start+1, 'occurred_at'=>$start+50]), $policy), 'changed approval date quarantined', $start+60);

edgeReviewDenied(Access::reduce(null, $event, edgePolicy(['verified'=>false])), 'unverified mapping denied', $start+100);
edgeReviewDenied(Access::reduce($grant, edgeEvent(['event_id'=>'edge-future', 'approved_at'=>$start+1000]), $policy), 'future approval denied', $start+100);
$missing = $event; unset($missing['approved_at']);
edgeReviewDenied(Access::reduce(null, $missing, $policy), 'missing approval denied', $start+100);
edgeReviewDenied(Access::reduce($grant, edgeEvent(['event_id'=>'edge-expires-parent', 'type'=>'expired', 'occurred_at'=>$end]), $policy), 'parent expiry event never silently expires all benefits', $end);

// A malformed or refunded transaction must not disable another independently valid purchase.
$separatePolicy = edgePolicy(['benefits'=>[['duration'=>'fixed_months', 'scopes'=>['app'], 'months'=>12, 'timezone'=>'America/Sao_Paulo']]]);
$separate = Access::reduce(null, edgeEvent(['transaction_id'=>'edge-independent-app', 'event_id'=>'edge-independent-approved']), $separatePolicy)['grant'];
edgeCheck(Access::allowed([$revive['grant'], $separate], 'app', $start+80), 'independent app survives a quarantined course bundle');
edgeCheck(!Access::allowed([$revive['grant'], $separate], 'course:penta', $start+80), 'independent app cannot recover revoked bundle courses');

echo json_encode(['suite'=>'benefit-policy-edge-cases', 'passed'=>$checks,
    'scope'=>'pure-policy adversarial ordering, immutable deadlines and mappings, malformed grants, independent sources',
    'inputs'=>'synthetic-only'], JSON_THROW_ON_ERROR) . PHP_EOL;
