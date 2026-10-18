<?php
declare(strict_types=1);
// Prepared, NOT executed in the current environment: no PHP runtime available.
// These fixtures are in-memory PHP test doubles, not another backend or live integration.
require_once __DIR__.'/../src/PlatformBackend.php';
require_once __DIR__.'/../src/HotmartEnvelope.php';
require_once __DIR__.'/../src/ResourceGate.php';
require_once __DIR__.'/../src/HttpKernel.php';
use Criasom\{PlatformBackend, PlatformProblem, HttpRequest, HttpKernel};

set_error_handler(static function(int $severity,string $message,string $file,int $line):never { throw new ErrorException($message,0,$severity,$file,$line); });
final class FixtureBackend implements PlatformBackend
{
    public bool $quotaAllowed=true;
    public array $sessions=[];
    public array $outbox=[];
    public array $state=[];
    public array $events=[];
    public array $seenUsers=[];
    public bool $failLogout=false;
    public bool $failPurchase=false;
    public function takeQuota(string $scope,string $bucket,int $limit,int $windowSeconds,int $now):bool {return $this->quotaAllowed;}
    public function session(string $token,int $now):?array {return $this->sessions[$token]??null;}
    public function requestCode(string $email,string $binding,string $bucket,int $now):array
    {
        $id=str_repeat('1',32); $this->outbox[$id]=['email'=>$email,'binding'=>$binding,'code'=>'01234567','used'=>false];
        return ['accepted'=>true,'challenge_id'=>$id,'expires_in'=>600,'code'=>'must-not-be-returned'];
    }
    public function confirmCode(string $id,string $code,string $binding,int $now):?array
    {
        $record=$this->outbox[$id]??null;
        if(!$record || $record['used'] || $record['binding']!==$binding || $record['code']!==$code)return null;
        $this->outbox[$id]['used']=true;
        $token=str_repeat('2',64); $csrf=str_repeat('3',64);
        $this->sessions[$token]=['id'=>'alice','email'=>'alice@example.test','verified'=>true,'csrf'=>$csrf];
        return ['cookie_token'=>$token,'csrf'=>$csrf,'expires_at'=>$now+43200];
    }
    public function logout(string $token,string $csrf,int $now):bool {if($this->failLogout)return false;unset($this->sessions[$token]);return true;}
    public function capabilities(array $user,int $now):array {return ['app','course:demo','repertoire'];}
    public function getState(array $user,string $area,int $now):array {$this->seenUsers[]=$user['id'];return $this->state[$user['id']][$area]??['revision'=>0,'data'=>[]];}
    public function saveState(array $user,string $area,int $revision,array|\stdClass $data,int $now):array
    {
        $current=$this->getState($user,$area,$now);
        if($current['revision']!==$revision)throw new PlatformProblem(409,'state_conflict');
        return $this->state[$user['id']][$area]=['revision'=>$revision+1,'data'=>$data];
    }
    public function resource(array $user,string $id,int $now):?array
    {
        $this->seenUsers[]=$user['id'];
        return $id==='owned' && $user['id']==='alice'?['body'=>'synthetic-resource','headers'=>['Content-Type'=>'text/plain','Location'=>'https://invalid.example.test/leak']]:null;
    }
    public function purchase(array $event,int $now):array
    {
        if($this->failPurchase)throw new RuntimeException('secret internal persistence detail');
        if(isset($this->events[$event['event_id']]))return ['disposition'=>'duplicate'];
        $this->events[$event['event_id']]=$event;return ['disposition'=>'review'];
    }
}
$checks=0;
function check(bool $ok,string $name):void {global $checks;if(!$ok)throw new RuntimeException('FAIL '.$name);$checks++;}
function data($r):array{return json_decode($r->body,true,32,JSON_THROW_ON_ERROR);}
function jar(array $cookies,array $old=[]):array {foreach($cookies as $cookie){[$name,$value]=explode('=',explode(';',$cookie,2)[0],2);$old[$name]=$value;}return $old;}
$backend=new FixtureBackend();
$kernel=new HttpKernel($backend,'https://app.example.test',str_repeat('k',32),'fixture-only-hottok');
$now=1800000000;
$send=static function(string $method,string $path,array $cookies=[],array $headers=[],string $body='',bool $https=true)use($kernel,$now){return $kernel->handle(new HttpRequest($method,'/api/v1'.$path,$headers,$cookies,$body,'192.0.2.10',$https),$now);};
$anon=$send('GET','/session');$a=data($anon);$cookies=jar($anon->cookies);
check($anon->status===200 && $a['authenticated']===false && strlen($a['csrf'])===64,'anonymous context');
check(str_contains($anon->cookies[0],'Secure; HttpOnly; SameSite=Lax')&&!str_contains($anon->cookies[0],'Domain='),'host-only secure cookie');
check($send('GET','/session',[],[],'',false)->status===400,'plain HTTP rejected');
$headers=['Origin'=>'https://app.example.test','X-CSRF-Token'=>$a['csrf'],'Content-Type'=>'application/json'];
check($send('POST','/auth/request-code',$cookies,array_replace($headers,['Origin'=>'https://attacker.example.test']),'{"email":"alice@example.test"}')->status===403 && !$backend->outbox,'cross-origin rejected before delivery');
check($send('POST','/auth/request-code',$cookies,array_replace($headers,['X-CSRF-Token'=>'bad']),'{"email":"alice@example.test"}')->status===403,'CSRF required');
check($send('POST','/auth/request-code',$cookies,$headers,'{"email":"alice@example.test","verified":true}')->status===400,'browser-supplied verification rejected');
$requested=$send('POST','/auth/request-code',$cookies,$headers,'{"email":"alice@example.test"}');
check($requested->status===202 && !str_contains($requested->body,'code"') && !str_contains($requested->body,'must-not'),'delivery code not in response');
$challenge=data($requested)['challenge_id'];
$other=$send('GET','/session');$otherHeaders=array_replace($headers,['X-CSRF-Token'=>data($other)['csrf']]);
$confirm=json_encode(['challenge_id'=>$challenge,'code'=>'01234567']);
check($send('POST','/auth/confirm-code',jar($other->cookies),$otherHeaders,$confirm)->status===422,'different browser binding rejected without resetting context');
$signed=$send('POST','/auth/confirm-code',$cookies,$headers,$confirm);$signedCookies=jar($signed->cookies,$cookies);
check($signed->status===200 && data($signed)===['authenticated'=>true] && !str_contains($signed->body,str_repeat('2',64)),'session token only cookie');
$session=$send('GET','/session',$signedCookies);$s=data($session);$authHeaders=array_replace($headers,['X-CSRF-Token'=>$s['csrf']]);
check($s['authenticated']===true && $s['user']['id']==='alice' && $s['capabilities']===['app','course:demo','repertoire'],'public session shape');
check($send('POST','/auth/request-code',$signedCookies,$authHeaders,'{"email":"bob@example.test"}')->status===409,'explicit logout required for account switch');
check($send('POST','/state/study',$signedCookies,$authHeaders,'{"expected_revision":0,"data":{},"user_id":"bob"}')->status===400,'state identity injection rejected');
$saved=$send('POST','/state/study',$signedCookies,$authHeaders,'{"expected_revision":0,"data":{"note":"test"}}');
check($saved->status===200 && data($saved)['revision']===1 && end($backend->seenUsers)==='alice','state belongs to session');
check($send('POST','/state/study',$signedCookies,$authHeaders,'{"expected_revision":0,"data":{}}')->status===409,'conflict not overwritten');
check(data($send('GET','/state/study',$signedCookies))['data']['note']==='test','persisted fixture state');
$shape=$send('POST','/state/preferences',$signedCookies,$authHeaders,'{"expected_revision":0,"data":{"settings":{},"map":{"0":"x"}}}');
$shapeData=json_decode($shape->body,false,32,JSON_THROW_ON_ERROR)->data;
check($shapeData->settings instanceof stdClass && $shapeData->map instanceof stdClass && $shapeData->map->{'0'}==='x','JSON object/list shape preserved');
$unicode=$send('POST','/state/preferences',$signedCookies,$authHeaders,json_encode(['expected_revision'=>1,'data'=>['note'=>str_repeat('é',12000)]],JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES));
check($unicode->status===200,'state limit measures UTF-8 without escaped Unicode expansion');
check($send('GET','/state/repertoire')->status===401,'anonymous state denied');
$file=$send('GET','/resources/owned',$signedCookies);
check($file->status===200 && $file->body==='synthetic-resource' && $file->headers['Cache-Control']==='private, no-store' && !isset($file->headers['Location']),'private resource with sanitized response headers');
check($send('GET','/resources/not-owned',$signedCookies)->status===404,'resource missing or denied indistinguishable');
check($send('GET','/resources/../owned',$signedCookies)->status===404,'path traversal denied');
check($send('POST','/state/study',$signedCookies,$authHeaders,json_encode(['expected_revision'=>1,'data'=>['note'=>str_repeat('x',65537)]]))->status===413,'state bound enforced');
check($send('POST','/auth/logout',$signedCookies,$authHeaders,str_repeat('x',131073))->status===413,'body bounded');
$backend->quotaAllowed=false;
check($send('GET','/session')->status===429,'global/requester quota denial');$backend->quotaAllowed=true;
$event=['id'=>'fixture-event','event'=>'PURCHASE_APPROVED','version'=>'2.0.0','creation_date'=>1800000000000,'data'=>['buyer'=>['email'=>'alice@example.test'],'product'=>['id'=>'fixture-product'],'purchase'=>['transaction'=>'fixture-transaction','offer'=>['code'=>'fixture-offer']]]];
$eventHeaders=['Content-Type'=>'application/json','X-Hotmart-Hottok'=>'fixture-only-hottok'];
check($send('POST','/webhooks/hotmart',[],array_replace($eventHeaders,['X-Hotmart-Hottok'=>'bad']),json_encode($event))->status===401 && !$backend->events,'untrusted webhook denied');
$received=$send('POST','/webhooks/hotmart',[],$eventHeaders,json_encode($event));
check($received->status===200 && data($received)['disposition']==='review' && !str_contains($received->body,'alice'),'service event independent of student CSRF and no buyer details returned');
check(data($send('POST','/webhooks/hotmart',[],$eventHeaders,json_encode($event)))['disposition']==='duplicate','duplicate fixture receipt');
$backend->failPurchase=true;
$failed=$send('POST','/webhooks/hotmart',[],$eventHeaders,json_encode($event));
check($failed->status===503 && !str_contains($failed->body,'secret'),'persistence failure not acknowledged or exposed');
$backend->failLogout=true;$failedLogout=$send('POST','/auth/logout',$signedCookies,$authHeaders,'{}');
check($failedLogout->status===503 && !$failedLogout->cookies,'failed server logout not reported complete');
$backend->failLogout=false;$out=$send('POST','/auth/logout',$signedCookies,$authHeaders,'{}');
check($out->status===200 && data($out)['signed_out']===true && !$backend->sessions,'logout revokes and expires cookies');
check(data($send('GET','/session',$signedCookies))['authenticated']===false,'revoked cookie not authenticated');
// A context close to expiry must still permit a newly issued challenge for its full advertised lifetime.
$nearExpiry=$kernel->handle(new HttpRequest('POST','/api/v1/auth/request-code',$headers,$cookies,'{"email":"alice@example.test"}','192.0.2.10',true),$now+1790);
$renewed=jar($nearExpiry->cookies,$cookies);
check($nearExpiry->status===202 && count($nearExpiry->cookies)===1,'context renewed before issuing challenge');
$lateConfirm=$kernel->handle(new HttpRequest('POST','/api/v1/auth/confirm-code',$headers,$renewed,$confirm,'192.0.2.10',true),$now+1805);
check($lateConfirm->status===200,'binding and CSRF survive renewal beyond original expiry');
check($send('POST','/auth/request-code',$cookies,$headers,'{"email":"alice@example.test"}')->headers['Cache-Control']==='private, no-store','errors and responses not cached');
echo json_encode(['suite'=>'http-kernel','passed'=>$checks,'scope'=>'PHP fixtures only; no real HTTP service or providers']).PHP_EOL;
