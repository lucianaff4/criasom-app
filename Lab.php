<?php
declare(strict_types=1);
namespace Criasom\Dev;

use Criasom\{HttpKernel,HttpRequest,HttpResponse,PlatformProblem,PdoPlatformBackend,PurchaseRepository,HotmartEnvelope,ResourceGate,ForumService};
use PDO;
use RuntimeException;

foreach (['PlatformBackend','AccessPolicy','AccountService','PurchaseRepository','ResourceGate','HotmartEnvelope','HttpKernel','PdoPlatformBackend','ForumService'] as $class) require_once dirname(__DIR__).'/src/'.$class.'.php';

/** Only the CLI development composition root uses this class. It is not a production bootstrap. */
final class Lab
{
    public const ACCOUNTS = ['penta@example.test'=>'penta','harmonia@example.test'=>'harmonia'];
    public readonly array $config;
    public readonly string $key;
    public readonly PDO $db;
    public readonly PdoPlatformBackend $backend;
    public readonly HttpKernel $kernel;
    private readonly string $dist;
    private array $data;

    public function __construct(bool $initialize = false)
    {
        if (!in_array(PHP_SAPI,['cli','cli-server'],true)) throw new RuntimeException('Laboratory is CLI-only.');
        $path = getenv('CRIASOM_LAB_CONFIG');
        if (!$path || !is_file($path)) throw new RuntimeException('Laboratory configuration unavailable.');
        $this->config = json_decode(file_get_contents($path),true,16,JSON_THROW_ON_ERROR);
        if (($this->config['mode']??'')!=='criasom-synthetic-loopback' || !is_int($this->config['httpsPort']??null)
            || !is_int($this->config['phpPort']??null) || $this->config['origin']!=='https://127.0.0.1:'.$this->config['httpsPort']
            || !preg_match('/^[a-f0-9]{64}$/D',$this->config['proxySecret']??'')
            || !preg_match('/^[a-f0-9]{64}$/D',$this->config['syntheticHotmartToken']??'')) throw new RuntimeException('Invalid laboratory configuration.');
        $this->key = base64_decode($this->config['applicationKeyBase64']??'',true)?:'';
        if(strlen($this->key)!==32)throw new RuntimeException('Invalid laboratory key.');
        $this->dist = dirname(__DIR__,2).'/criasom-app-piloto/dist';
        $this->data = json_decode(file_get_contents($this->dist.'/data.json'),true,128,JSON_THROW_ON_ERROR);
        $dbPath=dirname($path).'/laboratory.sqlite';
        if(!$initialize&&!is_file($dbPath))throw new RuntimeException('Initialize the CLI laboratory first.');
        $fresh=!is_file($dbPath);
        $this->db=new PDO('sqlite:'.$dbPath);
        $this->db->setAttribute(PDO::ATTR_ERRMODE,PDO::ERRMODE_EXCEPTION);
        if($fresh){if(!$initialize||PHP_SAPI!=='cli')throw new RuntimeException('CLI initialization required.');$this->db->exec(file_get_contents(dirname(__DIR__).'/sql/sqlite.sql'));}
        if($initialize)$this->db->exec(file_get_contents(dirname(__DIR__).'/sql/forum-sqlite.sql'));
        $this->backend=new PdoPlatformBackend($this->db,$this->key,self::policies(),$this->dist.'/assets');
        $this->kernel=new HttpKernel($this->backend,$this->config['origin'],$this->key,$this->config['syntheticHotmartToken'],new ForumService($this->db,$this->backend,$this->data['modules']));
        if($initialize){if(PHP_SAPI!=='cli')throw new RuntimeException('CLI initialization required.');$this->seed($fresh);$this->db->exec("INSERT OR IGNORE INTO forum_moderators(user_id) SELECT id FROM users WHERE email='penta@example.test'");}
    }
    public static function policies():array
    {
        return array_map(static fn($course)=>['verified'=>true,'product_id'=>'TESTE-'.$course,'offer_code'=>'TESTE-local','duration'=>'lifetime','scopes'=>['app','course:'.$course]],['penta','harmonia']);
    }
    private function seed(bool $fresh):void
    {
        // Explicit synthetic identities must exist before the CLI assigns the demo role.
        // No session or real email verification is created by this laboratory fixture.
        $user=$this->db->prepare('INSERT INTO users (id,email,email_verified_at,created_at) VALUES (?,?,?,?) ON CONFLICT(email) DO NOTHING');
        foreach(self::ACCOUNTS as $email=>$course)$user->execute([bin2hex(random_bytes(16)),$email,time(),time()]);
        if($fresh)foreach(self::ACCOUNTS as $email=>$course){
            $raw=json_encode(['id'=>'TESTE-seed-'.$course,'event'=>'PURCHASE_APPROVED','version'=>'2.0.0','creation_date'=>time()*1000,
                'data'=>['buyer'=>['email'=>$email],'product'=>['id'=>'TESTE-'.$course],'purchase'=>['transaction'=>'TESTE-compra-'.$course,'offer'=>['code'=>'TESTE-local']]]],JSON_THROW_ON_ERROR);
            $event=HotmartEnvelope::normalize($raw,$this->config['syntheticHotmartToken'],$this->config['syntheticHotmartToken']);
            $this->backend->purchase($event,time());
        }
        $insert=$this->db->prepare('INSERT INTO protected_objects (id,storage_key,provider,mime,required_scopes_json,visibility,owner_id,status) VALUES (?,?,?,?,?,?,NULL,?) ON CONFLICT(id) DO NOTHING');
        foreach($this->assetManifest() as $file=>$item)$insert->execute([$item['id'],basename($file),'local',$item['mime'],json_encode(['course:'.$item['course']],JSON_THROW_ON_ERROR),'course','active']);
    }
    private function assetManifest():array
    {
        $manifest=[];
        foreach(array_merge(array_values($this->data['pages']??[]),$this->data['tracks']??[]) as $item){
            $file=$item['file']??'';
            if(!is_string($file)||!preg_match('#^assets/([a-zA-Z0-9_-]+)\.(jpg|png|mp3)$#D',$file,$m))throw new RuntimeException('Unexpected laboratory asset.');
            $course=$item['course']??(str_starts_with(basename($file),'dah-')?'harmonia':'penta');
            if(!in_array($course,['penta','harmonia'],true))throw new RuntimeException('Unknown asset scope.');
            $manifest[$file]=['id'=>'lab-asset-'.substr(hash('sha256',$file),0,32),'course'=>$course,'mime'=>['jpg'=>'image/jpeg','png'=>'image/png','mp3'=>'audio/mpeg'][$m[2]]];
        }
        return $manifest;
    }
    public function trustedRequest():HttpRequest
    {
        if(PHP_SAPI!=='cli-server'||($_SERVER['REMOTE_ADDR']??'')!=='127.0.0.1'
            ||($_SERVER['HTTP_HOST']??'')!=='127.0.0.1:'.$this->config['httpsPort']
            ||!hash_equals($this->config['proxySecret'],(string)($_SERVER['HTTP_X_CRIASOM_LAB_TRANSPORT']??'')))throw new PlatformProblem(403,'laboratory_transport_required');
        $request=HttpRequest::fromGlobals();
        // Only the loopback TLS proxy knows this per-laboratory header. Other forwarded headers are ignored.
        unset($request->headers['x-criasom-lab-transport']);
        return new HttpRequest($request->method,$request->path,$request->headers,$request->cookies,$request->body,'127.0.0.1',true);
    }
    public static function json(int $status,array $body):HttpResponse
    {
        return new HttpResponse($status,['Content-Type'=>'application/json; charset=utf-8','Cache-Control'=>'private, no-store','Vary'=>'Cookie','X-Content-Type-Options'=>'nosniff','Referrer-Policy'=>'no-referrer','Cross-Origin-Resource-Policy'=>'same-origin'],json_encode($body,JSON_THROW_ON_ERROR|JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES));
    }
    private function user(HttpRequest $r):?array{return $this->backend->session($r->cookie('__Host-criasom_session'),time());}
    private function capabilities(HttpRequest $r):array{$u=$this->user($r);return $u?$this->backend->capabilities($u,time()):[];}
    private static function clean(mixed $value):mixed
    {
        if(!is_array($value))return $value;
        $hidden=['source','sourceSha256','sourceFrame','sourceInputLog','fullDecodeLog','documentaryEvidence','visualReview','currentVisualReview','pageMappingEvidence','editorial','coverage','textExcerpt','originalSource','preparedAt'];
        $out=[];foreach($value as $key=>$item){if(is_string($key)&&in_array($key,$hidden,true))continue;$out[$key]=self::clean($item);}return $out;
    }
    public function filteredData(HttpRequest $r):HttpResponse
    {
        $caps=$this->capabilities($r);
        if(!$this->user($r))return self::json(401,['error'=>'sign_in_required']);
        $allowed=static fn($course)=>in_array('app',$caps,true)&&in_array('course:'.$course,$caps,true);
        $pages=[];foreach($this->data['pages'] as $key=>$page){$course=$page['course']??(str_starts_with((string)$key,'harmonia:')?'harmonia':'penta');if($allowed($course))$pages[$key]=self::clean($page);}
        return self::json(200,['version'=>$this->data['version'],'laboratoryOnly'=>true,'courses'=>self::clean($this->data['courses']),
            'moduleCatalog'=>array_values(array_filter($this->data['moduleCatalog'],static fn($m)=>$allowed($m['courseId']??'penta'))),
            'modules'=>array_values(array_map([self::class,'clean'],array_filter($this->data['modules'],static fn($m)=>$allowed($m['courseId']??'penta')))),
            'pages'=>(object)$pages,'tracks'=>array_values(array_map([self::class,'clean'],array_filter($this->data['tracks'],static fn($t)=>$allowed($t['course']??'penta')))),
            'positions'=>$allowed('penta')?$this->data['positions']:new \stdClass(),'manual'=>[]]);
    }
    private function localCode(HttpRequest $r):HttpResponse
    {
        if($r->method!=='POST')return self::json(405,['error'=>'method_not_allowed']);
        if($r->header('origin')!==$this->config['origin']||$r->header('sec-fetch-site')==='cross-site')return self::json(403,['error'=>'origin_denied']);
        if(strlen($r->body)>1024||!preg_match('/^application\/json(?:\s*;\s*charset=utf-8)?$/iD',$r->header('content-type')))return self::json(400,['error'=>'invalid_lab_request']);
        $context=$r->cookie('__Host-criasom_context');$now=time();
        if(!preg_match('/^([a-f0-9]{64})\.([0-9]{10,12})\.([a-f0-9]{64})$/D',$context,$m))return self::json(403,['error'=>'lab_context_required']);
        $sign=fn($text)=>hash_hmac('sha256',$text,$this->key);
        if((int)$m[2]<=$now||(int)$m[2]>$now+1800||!hash_equals($sign('context:'.$m[1].'.'.$m[2]),$m[3])||!hash_equals($sign('anon-csrf:'.$m[1]),$r->header('x-csrf-token')))return self::json(403,['error'=>'lab_context_required']);
        $body=json_decode($r->body,true,8,JSON_THROW_ON_ERROR);
        if(!is_array($body)||array_keys($body)!==['challenge_id']||!is_string($body['challenge_id'])||!preg_match('/^[a-f0-9]{32}$/D',$body['challenge_id']))return self::json(400,['error'=>'invalid_lab_request']);
        if(!$this->backend->takeQuota('laboratory-code',$m[1],20,60,$now))return self::json(429,['error'=>'try_later']);
        $q=$this->db->prepare('SELECT c.email,c.binding_hash,c.expires_at,c.used_at,o.payload_sealed FROM auth_challenges c JOIN email_outbox o ON o.id=c.id WHERE c.id=?');$q->execute([$body['challenge_id']]);$row=$q->fetch(PDO::FETCH_ASSOC);
        if(!$row||!array_key_exists($row['email'],self::ACCOUNTS)||$row['used_at']!==null||(int)$row['expires_at']<=$now||!hash_equals($sign($m[1]),$row['binding_hash']))return self::json(404,['error'=>'synthetic_message_unavailable']);
        $sealed=json_decode($row['payload_sealed'],true,8,JSON_THROW_ON_ERROR);
        $plain=openssl_decrypt(base64_decode($sealed['cipher'],true),'aes-256-gcm',$this->key,OPENSSL_RAW_DATA,base64_decode($sealed['nonce'],true),base64_decode($sealed['tag'],true),$sealed['aad']);
        if($plain===false)throw new RuntimeException('Synthetic message unavailable.');
        $mail=json_decode($plain,true,8,JSON_THROW_ON_ERROR);
        if(($mail['to']??null)!==$row['email']||!preg_match('/^[0-9]{8}$/D',$mail['code']??''))throw new RuntimeException('Synthetic message unavailable.');
        return self::json(200,['laboratory_only'=>true,'delivery'=>'simulated-local-outbox','code'=>$mail['code'],'expires_at'=>(int)$row['expires_at']]);
    }
    public function handle(HttpRequest $r):HttpResponse
    {
        if($r->header('sec-fetch-site')==='cross-site')return self::json(403,['error'=>'origin_denied']);
        if(str_contains($r->path,'?')||str_contains($r->path,'%')||str_contains($r->path,'..')||str_contains($r->path,'\\'))return self::json(404,['error'=>'not_found']);
        if($r->path==='/__lab/status')return self::json(200,['lab'=>true,'mode'=>'synthetic-only','production'=>false,'email_delivery'=>'local-simulation','accounts'=>array_keys(self::ACCOUNTS),'accountCourses'=>array_map(static fn($email,$course)=>['email'=>$email,'courseId'=>$course],array_keys(self::ACCOUNTS),array_values(self::ACCOUNTS)),'unconnected'=>['repertoire','teacher-review','external-media']]);
        if($r->path==='/__lab/code')return $this->localCode($r);
        if(str_starts_with($r->path,'/api/v1/')){
            if($r->path==='/api/v1/auth/request-code'){
                try{$body=json_decode($r->body,true,8,JSON_THROW_ON_ERROR);}catch(\JsonException){return self::json(400,['error'=>'invalid_json']);}
                if(!is_array($body)||!is_string($body['email']??null)||!array_key_exists(strtolower(trim($body['email'])),self::ACCOUNTS))return self::json(400,['error'=>'synthetic_accounts_only']);
            }
            if($r->path==='/api/v1/webhooks/hotmart'){
                try{$event=HotmartEnvelope::normalize($r->body,$r->header('x-hotmart-hottok'),$this->config['syntheticHotmartToken']);}
                catch(\Throwable){return self::json(401,['error'=>'synthetic_source_required']);}
                if(!array_key_exists($event['email'],self::ACCOUNTS)||!str_starts_with($event['event_id'],'TESTE-')||!str_starts_with($event['transaction_id'],'TESTE-')||!in_array($event['product_id'],['TESTE-penta','TESTE-harmonia'],true)||$event['offer_code']!=='TESTE-local')return self::json(400,['error'=>'synthetic_events_only']);
            }
            return $this->kernel->handle($r,time());
        }
        if(!in_array($r->method,['GET','HEAD'],true))return self::json(405,['error'=>'method_not_allowed']);
        if($r->path==='/')return new HttpResponse(302,['Location'=>'/app/','Cache-Control'=>'no-store'],'');
        if($r->path==='/app/data.json')return $this->filteredData($r);
        $static=['/app/styles.css'=>[$this->dist.'/styles.css','text/css; charset=utf-8'],
            '/app/app.js'=>[$this->dist.'/app.js','text/javascript; charset=utf-8'], '/app/model.js'=>[$this->dist.'/model.js','text/javascript; charset=utf-8']];
        foreach(['account-bootstrap.mjs','study-account-bridge.mjs','platform-client.mjs','forum-client.mjs'] as $name)$static['/app/'.$name]=[dirname(__DIR__).'/client/'.$name,'text/javascript; charset=utf-8'];
        if($r->path==='/app/'||$r->path==='/app/index.html'){
            $html=file_get_contents($this->dist.'/index.html');
            $old='<script type="module" src="app.js"></script>';
            if(substr_count($html,$old)!==1)throw new RuntimeException('Pilot entry changed; review bootstrap injection.');
            return new HttpResponse(200,['Content-Type'=>'text/html; charset=utf-8','Cache-Control'=>'private, no-store','X-Content-Type-Options'=>'nosniff','Referrer-Policy'=>'no-referrer','X-Frame-Options'=>'DENY'],str_replace($old,'<script type="module" src="account-bootstrap.mjs"></script>',$html));
        }
        if(isset($static[$r->path])){[$file,$mime]=$static[$r->path];if(!is_file($file))return self::json(503,['error'=>'laboratory_bridge_not_ready']);return new HttpResponse(200,['Content-Type'=>$mime,'Cache-Control'=>'no-store','X-Content-Type-Options'=>'nosniff'],file_get_contents($file));}
        // Files, DB, keys, source, Repertório and demo community media have no generic static fallback.
        return self::json(404,['error'=>'not_found']);
    }
    public function streamAsset(HttpRequest $r):bool
    {
        if(!preg_match('#^/app/(assets/[a-zA-Z0-9_-]+\.(?:png|jpg|mp3))$#D',$r->path,$m))return false;
        if(!in_array($r->method,['GET','HEAD'],true)||$r->header('sec-fetch-site')==='cross-site'){self::json(404,['error'=>'not_found'])->emit();return true;}
        $file=$m[1];$public=[];foreach($this->data['courses'] as $c)$public[$c['cover']]=true;
        if(isset($public[$file])){$mime='image/png';$path=ResourceGate::localPath($this->dist.'/assets',basename($file));}
        else{
            $manifest=$this->assetManifest();$item=$manifest[$file]??null;$user=$this->user($r);
            if(!$item||!$user){self::json(404,['error'=>'not_found'])->emit();return true;}
            $q=$this->db->prepare('SELECT * FROM protected_objects WHERE id=?');$q->execute([$item['id']]);$object=$q->fetch(PDO::FETCH_ASSOC);
            if(!$object){self::json(404,['error'=>'not_found'])->emit();return true;}
            $object['required_scopes']=json_decode($object['required_scopes_json'],true,8,JSON_THROW_ON_ERROR);
            if(!ResourceGate::allowed($user,(new PurchaseRepository($this->db))->forVerifiedUser($user),$object,time())){self::json(404,['error'=>'not_found'])->emit();return true;}
            $mime=$object['mime'];if(!in_array($mime,['image/png','image/jpeg','audio/mpeg'],true))throw new RuntimeException('Invalid asset type.');
            $path=ResourceGate::localPath($this->dist.'/assets',$object['storage_key']);
        }
        $size=filesize($path);if(!is_int($size)||$size<1||$size>16777216)throw new RuntimeException('Invalid asset size.');
        $start=0;$end=$size-1;$partial=false;$range=$r->header('range');
        if($range!==''){
            if(!preg_match('/^bytes=([0-9]*)-([0-9]*)$/D',$range,$match)||($match[1]===''&&$match[2]==='')){http_response_code(416);header('Content-Range: bytes */'.$size);header('Cache-Control: private, no-store');return true;}
            if($match[1]===''){$suffix=(int)$match[2];if($suffix<1){http_response_code(416);header('Content-Range: bytes */'.$size);header('Cache-Control: private, no-store');return true;}$start=max(0,$size-$suffix);}
            else{$start=(int)$match[1];$end=$match[2]===''?$size-1:min($size-1,(int)$match[2]);}
            if($start>$end||$start>=$size){http_response_code(416);header('Content-Range: bytes */'.$size);header('Cache-Control: private, no-store');return true;}$partial=true;
        }
        http_response_code($partial?206:200);header('Content-Type: '.$mime);header('Content-Disposition: inline');header('Cache-Control: private, no-store');header('Vary: Cookie');header('X-Content-Type-Options: nosniff');header('Cross-Origin-Resource-Policy: same-origin');header('Referrer-Policy: no-referrer');header('Accept-Ranges: bytes');header('Content-Length: '.($end-$start+1));
        if($partial)header('Content-Range: bytes '.$start.'-'.$end.'/'.$size);
        if($r->method==='HEAD')return true;
        $h=fopen($path,'rb');if($h===false)throw new RuntimeException('Asset unavailable.');
        try{fseek($h,$start);$left=$end-$start+1;while($left>0&&!feof($h)){$chunk=fread($h,min($left,65536));if($chunk===false)break;echo $chunk;$left-=strlen($chunk);}}finally{fclose($h);}return true;
    }
}
