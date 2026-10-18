<?php
declare(strict_types=1);
namespace Criasom;
use PDO;
use RuntimeException;
use Throwable;

final class PurchaseRepository
{
    public function __construct(private PDO $db) { $db->setAttribute(PDO::ATTR_ERRMODE,PDO::ERRMODE_EXCEPTION); }
    private function query(string $sql,array $params=[]): \PDOStatement { $q=$this->db->prepare($sql);$q->execute($params);return $q; }
    private function quarantine(string $transactionId,string $reason):void
    {
        $this->db->beginTransaction();
        try {
            $lock=$this->db->getAttribute(PDO::ATTR_DRIVER_NAME)==='sqlite'?'':' FOR UPDATE';
            $row=$this->query('SELECT state_json FROM purchase_sources WHERE transaction_id=?'.$lock,[$transactionId])->fetch(PDO::FETCH_ASSOC);
            if($row){
                $state=json_decode($row['state_json'],true,64,JSON_THROW_ON_ERROR);
                if(is_array($state))$state['status']='review';
                $this->query('UPDATE purchase_sources SET quarantine_reason=?,state_json=?,revision=revision+1 WHERE transaction_id=?',[$reason,json_encode($state,JSON_THROW_ON_ERROR),$transactionId]);
            }
            $this->db->commit();
        } catch(Throwable $e){if($this->db->inTransaction())$this->db->rollBack();throw $e;}
    }

    /** Only call after HotmartEnvelope authentication or an audited import/reconciliation. */
    public function apply(array $event,array $policy,int $receivedAt): array
    {
        foreach(['event_id','transaction_id','email','product_id','offer_code','payload_hash'] as $field)
            if(!is_string($event[$field]??null)) throw new RuntimeException('Invalid normalized event.');
        if(!preg_match('/^[a-f0-9]{64}$/D',$event['payload_hash'])) throw new RuntimeException('Invalid event digest.');
        $duplicate=function()use($event):?array {
            $r=$this->query('SELECT payload_hash,transaction_id FROM purchase_events WHERE event_id=?',[$event['event_id']])->fetch(PDO::FETCH_ASSOC);
            if(!$r)return null;
            if(!hash_equals($r['payload_hash'],$event['payload_hash'])){
                $this->quarantine($r['transaction_id'],'event_id_payload_conflict');
                throw new RuntimeException('Conflicting event ID.');
            }
            return ['disposition'=>'duplicate','reason'=>'global_event_already_committed'];
        };
        if($found=$duplicate())return $found;
        $this->db->beginTransaction();
        try {
            $sqlite=$this->db->getAttribute(PDO::ATTR_DRIVER_NAME)==='sqlite';
            $insert=$sqlite
                ? 'INSERT INTO purchase_sources (transaction_id,email,product_id,offer_code,state_json,revision) VALUES (?,?,?,?,?,0) ON CONFLICT(transaction_id) DO NOTHING'
                : 'INSERT INTO purchase_sources (transaction_id,email,product_id,offer_code,state_json,revision) VALUES (?,?,?,?,?,0) ON DUPLICATE KEY UPDATE transaction_id=transaction_id';
            $this->query($insert,[$event['transaction_id'],strtolower($event['email']),$event['product_id'],$event['offer_code'],'null']);
            $row=$this->query('SELECT * FROM purchase_sources WHERE transaction_id=?'.($sqlite?'':' FOR UPDATE'),[$event['transaction_id']])->fetch(PDO::FETCH_ASSOC);
            $current=json_decode($row['state_json'],true,64,JSON_THROW_ON_ERROR);
            $result=($row['quarantine_reason']??null)!==null
                ? ['disposition'=>'review','grant'=>$current,'reason'=>'manual_resolution_required']
                : AccessPolicy::reduce($current,$event,$policy);
            if($result['disposition']==='review' && is_array($result['grant']))$result['grant']['status']='review';
            // Existing grants returned as review MUST be persisted, not silently kept active.
            $this->query('INSERT INTO purchase_events (event_id,payload_hash,transaction_id,disposition,received_at) VALUES (?,?,?,?,?)',[$event['event_id'],$event['payload_hash'],$event['transaction_id'],$result['disposition'],$receivedAt]);
            $reason=$result['disposition']==='review'?$result['reason']:null;
            $this->query('UPDATE purchase_sources SET state_json=?,quarantine_reason=?,revision=revision+1 WHERE transaction_id=?',[json_encode($result['grant'],JSON_THROW_ON_ERROR),$reason,$event['transaction_id']]);
            $this->db->commit();return $result;
        } catch(Throwable $e) {
            if($this->db->inTransaction())$this->db->rollBack();
            // A concurrent delivery may have won the unique event insert; verify before acknowledging.
            if($e instanceof \PDOException && in_array((string)$e->getCode(),['23000','23505'],true)) {
                if($found=$duplicate())return $found;
            }
            throw $e;
        }
    }

    public function forVerifiedUser(array $user): array
    {
        if(($user['verified']??false)!==true || !is_string($user['id']??null) || $user['id']==='' || !is_string($user['email']??null) || !filter_var($user['email'],FILTER_VALIDATE_EMAIL))return [];
        $rows=$this->query('SELECT state_json FROM purchase_sources WHERE email=? AND quarantine_reason IS NULL',[strtolower($user['email'])])->fetchAll(PDO::FETCH_COLUMN);
        $grants=[];
        foreach($rows as $json){$grant=json_decode($json,true,64,JSON_THROW_ON_ERROR);if(is_array($grant)&&($grant['email']??null)===strtolower($user['email']))$grants[]=$grant;}
        return $grants;
    }
}
