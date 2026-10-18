<?php
declare(strict_types=1);

namespace Criasom;

/** Pure domain rules; no authentication, persistence, provider calls or real products.
 * One source per purchase transaction. Its benefits can have independent durations.
 * A new purchase creates another source; periods overlap and are never silently stacked.
 * The adapter must authenticate and normalize events, resolve a verified mapping,
 * lock the transaction, persist the result and deduplicate event IDs globally.
 * Policy: verified, product_id, offer_code, scopes, duration=lifetime|paid_through.
 * Grant: transaction_id/email/product_id/offer_code, scopes/duration, status/state,
 * valid_from, paid_through, last_event_id/at/type, event_hashes[id=>sha256].
 * paid_through is an EXCLUSIVE Unix-second cutoff, never a guessed billing period.
 * Fixed one-off offers use benefits=[scopes,duration=lifetime|fixed_months,months,timezone].
 * They resolve calendar cutoffs from the verified purchase approval date; not subscriptions.
 * A review quarantines this transaction only; an independent valid grant survives.
 */
final class AccessPolicy
{
    public static function allowed(array $grants, string $scope, int $now): bool
    {
        return self::entitled($grants, 'app', $now) && self::entitled($grants, $scope, $now);
    }

    /** Ownership independent of app membership; does not authorize an app resource by itself. */
    public static function entitled(array $grants, string $scope, int $now): bool
    {
        if (!self::scopeValid($scope) || $now < 0) return false;
        foreach ($grants as $grant) {
            if (!is_array($grant) || ($grant['status'] ?? null) !== 'active') continue;
            // Never fall back to the parent lifetime envelope for a benefit-based grant.
            $benefits = array_key_exists('benefits', $grant) ? $grant['benefits'] : [$grant];
            if (!is_array($benefits)) continue;
            foreach ($benefits as $benefit) {
                if (!is_array($benefit) || !is_int($benefit['valid_from'] ?? null)
                    || $benefit['valid_from'] < 0 || $benefit['valid_from'] > $now
                    || !is_array($benefit['scopes'] ?? null) || !array_key_exists('paid_through', $benefit)) continue;
                $end = $benefit['paid_through'];
                $duration = $benefit['duration'] ?? null;
                if ($duration === 'lifetime' && $end !== null) continue;
                if ($duration === 'paid_through' && (!is_int($end) || $end <= $now)) continue;
                if (!in_array($duration, ['lifetime', 'paid_through'], true)) continue;
                if (in_array($scope, $benefit['scopes'], true)) return true;
            }
        }
        return false;
    }

    /** Input is normalized data, NOT the raw Hotmart webhook payload. */
    public static function reduce(?array $current, array $event, array $policy): array
    {
        if (array_key_exists('benefits', $policy) || ($current !== null && array_key_exists('benefits', $current)))
            return self::reduceBenefits($current, $event, $policy);
        return self::reduceLegacy($current, $event, $policy);
    }

    /** One-off purchase with independently expiring benefits, sharing refund provenance. */
    private static function reduceBenefits(?array $current, array $event, array $policy): array
    {
        $review = static function (string $reason) use ($current): array {
            $grant = $current;
            if ($grant !== null) $grant['status'] = 'review';
            return ['disposition' => 'review', 'grant' => $grant, 'reason' => $reason];
        };
        $definitions = self::benefitDefinitions($policy);
        if ($definitions === null) return $review('invalid_benefit_policy');
        if ($current !== null && ($current['benefit_policy'] ?? null) !== $definitions)
            return $review('mapping_changed_requires_review');
        if (!in_array($event['type'] ?? null, ['approved', 'refunded', 'chargeback', 'delayed'], true))
            return $review('one_off_purchase_event_requires_review');
        if (($event['paid_through'] ?? null) !== null) return $review('unexpected_paid_period_for_fixed_offer');
        if (($event['type'] ?? null) === 'approved') {
            if (!is_int($event['approved_at'] ?? null) || $event['approved_at'] < 0
                || !is_int($event['occurred_at'] ?? null) || $event['approved_at'] > $event['occurred_at'])
                return $review('missing_or_invalid_approval_date');
            if (isset($current['approved_at']) && $current['approved_at'] !== $event['approved_at'])
                return $review('approval_date_changed_requires_review');
        }
        $scopes = [];
        foreach ($definitions as $definition) $scopes = array_merge($scopes, $definition['scopes']);
        // Reuse identity, ordering, global transaction state and replay guards. The parent's
        // lifetime is only its state envelope: entitled() exclusively reads nested benefits.
        $envelopePolicy = $policy;
        unset($envelopePolicy['benefits']);
        $envelopePolicy['duration'] = 'lifetime';
        $envelopePolicy['scopes'] = array_values(array_unique($scopes));
        $result = self::reduceLegacy($current, $event, $envelopePolicy);
        if ($result['disposition'] !== 'applied') return $result;
        $grant = $result['grant'];
        $grant['benefit_policy'] = $definitions;
        $grant['benefits'] = $current['benefits'] ?? [];
        if ($event['type'] === 'approved') {
            $grant['approved_at'] = $event['approved_at'];
            $grant['valid_from'] = $event['approved_at'];
            $grant['benefits'] = [];
            foreach ($definitions as $definition) {
                $end = $definition['duration'] === 'lifetime' ? null
                    : self::calendarEnd($event['approved_at'], $definition['months'], $definition['timezone']);
                $grant['benefits'][] = ['scopes' => $definition['scopes'],
                    'duration' => $end === null ? 'lifetime' : 'paid_through',
                    'valid_from' => $event['approved_at'], 'paid_through' => $end];
            }
        }
        $result['grant'] = $grant;
        return $result;
    }

    private static function benefitDefinitions(array $policy): ?array
    {
        if (array_key_exists('duration', $policy) || array_key_exists('scopes', $policy)
            || !is_array($policy['benefits'] ?? null) || !array_is_list($policy['benefits'])
            || !$policy['benefits'] || count($policy['benefits']) > 100) return null;
        $definitions = []; $seen = [];
        foreach ($policy['benefits'] as $item) {
            if (!is_array($item) || !in_array($item['duration'] ?? null, ['lifetime', 'fixed_months'], true)
                || !is_array($item['scopes'] ?? null) || !array_is_list($item['scopes']) || !$item['scopes']) return null;
            foreach ($item['scopes'] as $scope) {
                if (!is_string($scope) || !self::scopeValid($scope) || isset($seen[$scope])) return null;
                $seen[$scope] = true;
            }
            $scopes = $item['scopes']; sort($scopes, SORT_STRING);
            $definition = ['scopes' => $scopes, 'duration' => $item['duration']];
            if ($item['duration'] === 'fixed_months') {
                if (!is_int($item['months'] ?? null) || $item['months'] < 1 || $item['months'] > 120
                    || !in_array($item['timezone'] ?? null, ['America/Sao_Paulo', 'UTC'], true)) return null;
                $definition += ['months' => $item['months'], 'timezone' => $item['timezone']];
            } elseif (array_key_exists('months', $item) || array_key_exists('timezone', $item)) return null;
            $definitions[] = $definition;
        }
        usort($definitions, static fn(array $a, array $b): int => strcmp(json_encode($a), json_encode($b)));
        return $definitions;
    }

    private static function calendarEnd(int $start, int $months, string $timezone): int
    {
        $date = (new \DateTimeImmutable('@' . $start))->setTimezone(new \DateTimeZone($timezone));
        $index = (int)$date->format('Y') * 12 + (int)$date->format('n') - 1 + $months;
        $year = intdiv($index, 12); $month = $index % 12 + 1;
        $first = $date->setDate($year, $month, 1);
        // Clamp month-end instead of PHP's overflowing Feb 29 + 1 year -> March 1.
        return $first->setDate($year, $month, min((int)$date->format('j'), (int)$first->format('t')))->getTimestamp();
    }

    private static function reduceLegacy(?array $current, array $event, array $policy): array
    {
        $review = static function (string $reason) use ($current): array {
            $grant = $current;
            if ($grant !== null) $grant['status'] = 'review';
            return ['disposition' => 'review', 'grant' => $grant, 'reason' => $reason];
        };
        $types = ['approved', 'refunded', 'chargeback', 'canceled', 'expired', 'delayed'];
        foreach (['event_id', 'transaction_id', 'email', 'product_id', 'offer_code', 'type'] as $field) {
            if (!is_string($event[$field] ?? null) || trim($event[$field]) === '')
                return $review('missing_or_invalid_' . $field);
        }
        if (!filter_var($event['email'], FILTER_VALIDATE_EMAIL)
            || !is_int($event['occurred_at'] ?? null) || $event['occurred_at'] < 0
            || !in_array($event['type'], $types, true)
            || !array_key_exists('paid_through', $event)
            || ($event['paid_through'] !== null && (!is_int($event['paid_through']) || $event['paid_through'] < 0)))
            return $review('invalid_normalized_event');
        $email = strtolower($event['email']);
        if ($current !== null) {
            foreach (['transaction_id', 'product_id', 'offer_code'] as $field)
                if (($current[$field] ?? null) !== $event[$field]) return $review('identity_mismatch_' . $field);
            if (($current['email'] ?? null) !== $email) return $review('email_changed_for_transaction');
        }
        if (($policy['verified'] ?? false) !== true
            || ($policy['product_id'] ?? null) !== $event['product_id']
            || ($policy['offer_code'] ?? null) !== $event['offer_code']
            || !in_array($policy['duration'] ?? null, ['lifetime', 'paid_through'], true)
            || !is_array($policy['scopes'] ?? null) || !$policy['scopes'])
            return $review('unverified_or_unmapped_offer');
        foreach ($policy['scopes'] as $scope)
            if (!is_string($scope) || !self::scopeValid($scope)) return $review('invalid_scope');
        $scopes = array_values(array_unique($policy['scopes']));
        sort($scopes);
        if ($current !== null && (($current['duration'] ?? null) !== $policy['duration']
            || ($current['scopes'] ?? null) !== $scopes)) return $review('mapping_changed_requires_review');
        $canonical = [];
        foreach (['event_id', 'transaction_id', 'occurred_at', 'type', 'email', 'product_id', 'offer_code', 'paid_through'] as $field)
            $canonical[$field] = $field === 'email' ? $email : $event[$field];
        if (array_key_exists('approved_at', $event)) $canonical['approved_at'] = $event['approved_at'];
        $hash = hash('sha256', json_encode($canonical, JSON_THROW_ON_ERROR));
        if (isset($current['event_hashes'][$event['event_id']])) {
            if ($current['event_hashes'][$event['event_id']] !== $hash) return $review('event_id_payload_conflict');
            return ['disposition' => 'duplicate', 'grant' => $current, 'reason' => 'event_already_recorded'];
        }
        if (($current['status'] ?? null) === 'review') return $review('manual_resolution_required');
        $type = $event['type'];
        $terminal = in_array($type, ['refunded', 'chargeback'], true);
        $lastAt = $current['last_event_at'] ?? -1;
        if (!$terminal && $event['occurred_at'] < $lastAt)
            return ['disposition' => 'stale', 'grant' => $current, 'reason' => 'older_event'];
        if (!$terminal && $event['occurred_at'] === $lastAt
            && $type !== ($current['last_event_type'] ?? null)) return $review('same_time_conflicting_events');
        if (in_array($current['state'] ?? null, ['refunded', 'chargeback', 'expired', 'canceled'], true)
            && $type === 'approved') return $review('transaction_cannot_be_revived');
        $end = $event['paid_through'];
        if ($type === 'approved') {
            if ($policy['duration'] === 'paid_through' && (!is_int($end) || $end <= $event['occurred_at']))
                return $review('approved_without_valid_paid_period');
            if ($policy['duration'] === 'lifetime' && $end !== null) return $review('contradictory_lifetime_period');
            if (($current['status'] ?? null) === 'active' && $current['paid_through'] !== $end)
                return $review('renewal_requires_independent_transaction');
        }
        if ($type === 'canceled') {
            $knownEnd = $current['paid_through'] ?? null;
            if (!is_int($knownEnd) || ($end !== null && $end !== $knownEnd))
                return $review('cancellation_without_matching_paid_end');
            $end = $knownEnd;
        }
        $grant = $current ?? [
            'transaction_id' => $event['transaction_id'], 'email' => $email,
            'product_id' => $event['product_id'], 'offer_code' => $event['offer_code'],
            'duration' => $policy['duration'], 'scopes' => $scopes,
            'status' => 'inactive', 'state' => $type, 'valid_from' => $event['occurred_at'],
            'paid_through' => null, 'event_hashes' => [],
        ];
        if ($terminal) {
            $grant['status'] = 'revoked';
            $grant['state'] = $type;
        } elseif (!in_array($grant['state'], ['refunded', 'chargeback'], true)) {
            if ($type === 'approved') {
                $grant['status'] = 'active';
                $grant['state'] = 'approved';
                $grant['paid_through'] = $end;
                if ($current === null || $current['status'] !== 'active') $grant['valid_from'] = $event['occurred_at'];
            } elseif ($type === 'canceled') {
                $grant['state'] = 'canceled'; // Keep only access already granted, until its paid cutoff.
                $grant['paid_through'] = $end;
            } elseif ($type === 'expired') {
                $grant['state'] = 'expired';
                $grant['status'] = 'revoked';
            }
            // delayed never creates access, extends its end, or clears cancellation.
        }
        $grant['event_hashes'][$event['event_id']] = $hash;
        $grant['last_event_id'] = $event['event_id'];
        $grant['last_event_at'] = max($lastAt, $event['occurred_at']);
        $grant['last_event_type'] = $type;
        return ['disposition' => 'applied', 'grant' => $grant,
            'reason' => $terminal ? 'terminal_revocation_wins_regardless_of_order' : 'event_applied'];
    }

    private static function scopeValid(string $scope): bool
    {
        return in_array($scope, ['app', 'repertoire'], true)
            || preg_match('/\A(?:course|agd):[a-z0-9][a-z0-9_-]*\z/D', $scope) === 1;
    }
}
