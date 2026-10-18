<?php
declare(strict_types=1);
namespace Criasom;
use RuntimeException;

/** Narrow purchase adapter. Subscriptions/expiry require authoritative reconciliation. */
final class HotmartEnvelope
{
    public static function normalize(string $body, string $providedToken, string $configuredToken): array
    {
        if ($configuredToken === '' || !hash_equals($configuredToken, $providedToken)) throw new RuntimeException('Unauthorized source.');
        if (strlen($body) > 131072) throw new RuntimeException('Event too large.');
        $raw = json_decode($body, true, 32, JSON_THROW_ON_ERROR);
        if (!is_array($raw) || ($raw['version'] ?? '') !== '2.0.0') throw new RuntimeException('Unsupported envelope.');
        $types = ['PURCHASE_APPROVED'=>'approved','PURCHASE_REFUNDED'=>'refunded','PURCHASE_CHARGEBACK'=>'chargeback'];
        foreach (['data'] as $key) if (!is_array($raw[$key] ?? null)) throw new RuntimeException('Malformed event.');
        $data = $raw['data'];
        foreach (['purchase','buyer','product'] as $key) if (!is_array($data[$key] ?? null)) throw new RuntimeException('Malformed event.');
        $purchase = $data['purchase'];
        if (!is_string($raw['event'] ?? null) || !is_string($data['buyer']['email'] ?? null)
            || (isset($purchase['offer']) && !is_array($purchase['offer']))) throw new RuntimeException('Malformed event.');
        $product = $data['product']['id'] ?? null;
        $offer = $purchase['offer']['code'] ?? '';
        if ((!is_int($product) && !is_string($product)) || !preg_match('/^[a-zA-Z0-9_-]{1,80}$/D', (string)$product)
            || !is_string($offer) || strlen($offer)>80 || ($offer !== '' && !preg_match('/^[a-zA-Z0-9_-]+$/D',$offer))) throw new RuntimeException('Malformed product or offer.');
        $id = $raw['id'] ?? ''; $transaction = $purchase['transaction'] ?? '';
        $milliseconds = $raw['creation_date'] ?? null;
        $email = strtolower(trim($data['buyer']['email']));
        if (!is_string($id) || !preg_match('/^[a-zA-Z0-9_-]{1,80}$/D', $id) || !is_string($transaction) || !preg_match('/^[a-zA-Z0-9_-]{1,80}$/D', $transaction) || !is_int($milliseconds) || $milliseconds < 1000000000000 || strlen($email)>254 || !filter_var($email,FILTER_VALIDATE_EMAIL)) throw new RuntimeException('Incomplete identity.');
        $event = ['event_id'=>$id,'transaction_id'=>$transaction,'occurred_at'=>intdiv($milliseconds,1000),'email'=>$email,'type'=>$types[$raw['event']] ?? 'unmapped','product_id'=>(string)$product,'offer_code'=>$offer,'paid_through'=>null,'payload_hash'=>hash('sha256',$body)];
        // A fixed-duration offer starts at approval, never at webhook delivery/creation.
        // Missing approval is retained as missing so legacy mappings still work; fixed
        // offers fail closed in AccessPolicy until an authoritative date is supplied.
        if (array_key_exists('approved_date', $purchase) && $purchase['approved_date'] !== null) {
            $approved = $purchase['approved_date'];
            if (!is_int($approved) || $approved < 1000000000000 || $approved > $milliseconds)
                throw new RuntimeException('Invalid approval date.');
            $event['approved_at'] = intdiv($approved, 1000);
        }
        return $event;
        // Never infer paid-through from the date of the next payment or a fixed number of days.
    }
}
