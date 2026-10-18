<?php
declare(strict_types=1);
$base=dirname(__DIR__);
foreach(['PlatformBackend','AccessPolicy','AccountService','PurchaseRepository','ResourceGate','HotmartEnvelope','PdoPlatformBackend','ForumService','HttpKernel']as$c)require_once $base.'/src/'.$c.'.php';
require_once $base.'/tests/support/HttpPdoFixture.php';
use Criasom\Test\HttpPdoFixture;
use Criasom\HttpResponse;
$checks=[];
function ok(bool $pass,string $name):void{global $checks;if(!$pass)throw new RuntimeException('FAILED: '.$name);$checks[]=$name;}
function status(HttpResponse $r,int $expected,string $name):object{ok($r->status===$expected,$name.' ('.$r->status.')');return json_decode($r->body);}
function login(HttpPdoFixture $f,string $who,string $email):object{
 status($f->call($who,'GET','/session'),200,'anonymous context');$r=status($f->call($who,'POST','/auth/request-code',['email'=>$email]),202,'request code');
 status($f->call($who,'POST','/auth/confirm-code',['challenge_id'=>$r->challenge_id,'code'=>$f->syntheticCode($r->challenge_id)]),200,'confirm code');
 return status($f->call($who,'GET','/session'),200,'session');
}
$f=new HttpPdoFixture(true);
try{
 status($f->deliver($f->event('forum-buy-a','forum-tx-a','a@example.test','fixture-penta')),200,'purchase A');
 status($f->deliver($f->event('forum-buy-b','forum-tx-b','b@example.test','fixture-repertoire')),200,'purchase B');
 $a=login($f,'a','a@example.test');$b=login($f,'b','b@example.test');$none=login($f,'none','none@example.test');
 status($f->call('anon','GET','/forum/options'),401,'anonymous denied');status($f->call('none','GET','/forum/options'),403,'no app denied');
 $options=status($f->call('a','GET','/forum/options'),200,'options');ok(count((array)$options->categories)===8,'eight themes');ok(count($options->modules)===3,'penta modules available');
 $optionsB=status($f->call('b','GET','/forum/options'),200,'other options');ok(count($optionsB->modules)===0,'no unpurchased modules');
 
 $empty=['space'=>'geral','category'=>'','moduleId'=>'','practiceId'=>'','query'=>'','cursor'=>0];
 status($f->call('a','POST','/forum/list',$empty),428,'community list requires consent');
 $draftBlocked=['requestId'=>str_repeat('0',32),'space'=>'geral','category'=>'conversas','title'=>'Sem aceite','body'=>'','links'=>[],'tags'=>[],'moduleId'=>'','practiceId'=>''];
 status($f->call('a','POST','/forum/posts',$draftBlocked),428,'community post requires consent');
 status($f->call('a','GET','/state/study'),200,'declining terms does not block personal study');
 foreach(['a','b']as$who){$d=status($f->call($who,'GET','/forum/terms/comunidade'),200,'community document')->document;status($f->call($who,'POST','/forum/terms/accept',['kind'=>'comunidade','version'=>$d->version,'documentHash'=>$d->hash,'accepted'=>true,'adult'=>false]),200,'independent community acceptance');}
 status($f->call('a','POST','/forum/profile',['name'=>'Aluno A']),200,'profile A');status($f->call('b','POST','/forum/profile',['name'=>'Aluno B']),200,'profile B');
 $draft=['requestId'=>str_repeat('a',32),'space'=>'geral','category'=>'equipamentos','title'=>'Como estudar timbre?','body'=>'Uma dúvida aberta.','links'=>['https://example.org/video','https://example.org/audio'],'tags'=>['timbre','assunto livre'],'moduleId'=>'','practiceId'=>''];
 $created=status($f->call('a','POST','/forum/posts',$draft),200,'A creates topic');$id=$created->post->id;ok($created->post->author->id===$a->user->id&&$created->post->author->name==='Aluno A','server supplies identity');
 ok(!str_contains(json_encode($created),'a@example.test'),'author email not disclosed');
 $duplicate=status($f->call('a','POST','/forum/posts',$draft),200,'repeated request accepted');ok($duplicate->post->id===$id,'retry not duplicated');
 status($f->call('a','POST','/forum/posts',array_replace($draft,['title'=>'Changed same request'])),409,'same request changed rejected');
 status($f->call('a','POST','/forum/posts',$draft+['authorId'=>$b->user->id]),400,'forged author rejected');
 status($f->call('a','POST','/forum/posts',array_replace($draft,['requestId'=>str_repeat('b',32)]),['X-CSRF-Token'=>'invalid']),403,'csrf required');
 status($f->call('a','POST','/forum/posts',$draft,['Origin'=>'https://foreign.example']),403,'foreign origin denied');
 $read=status($f->call('b','GET','/forum/posts/'.$id),200,'B reads topic');ok(!$read->post->own&&count($read->post->links)===2,'other author and links intact');
 $reply=['requestId'=>str_repeat('c',32),'body'=>'Eu começo com som limpo.','links'=>['https://example.org/reference']];
 $saved=status($f->call('b','POST','/forum/posts/'.$id.'/comments',$reply),200,'B replies');
 $retry=status($f->call('b','POST','/forum/posts/'.$id.'/comments',$reply),200,'B reply retry');ok($saved->commentId===$retry->commentId,'reply retry not duplicated');
 $dialog=status($f->call('a','GET','/forum/posts/'.$id),200,'A sees response');ok(count($dialog->comments)===1&&$dialog->comments[0]->author->id===$b->user->id,'dialog shares two real account identities');
 $edit=['expectedRevision'=>$dialog->post->revision,'category'=>'duvidas','title'=>'Dúvida de timbre editada','body'=>'Meu texto revisto','links'=>[],'tags'=>['estudo']];
 status($f->call('b','POST','/forum/posts/'.$id.'/edit',$edit),403,'B cannot edit A');
 status($f->call('a','POST','/forum/posts/'.$id.'/edit',array_replace($edit,['expectedRevision'=>1])),409,'stale edit does not overwrite conversation');
 status($f->call('a','POST','/forum/posts/'.$id.'/edit',$edit),200,'A edits own topic');
 status($f->call('b','POST','/forum/posts/'.$id.'/remove',new stdClass()),403,'B cannot remove A topic');
 status($f->call('a','POST','/forum/posts/'.$id.'/comments/'.$saved->commentId.'/remove',new stdClass()),403,'A cannot remove B reply');
 foreach(['javascript:alert(1)','data:text/html,bad','https://user:pass@example.org','https://example.org\\evil']as$i=>$link)status($f->call('a','POST','/forum/posts',array_replace($draft,['requestId'=>str_pad(dechex($i+50),32,'0',STR_PAD_LEFT),'links'=>[$link]])),400,'unsafe link rejected '.$i);
 status($f->call('a','POST','/forum/posts',array_replace($draft,['requestId'=>str_repeat('d',32),'body'=>str_repeat('á',6001)])),400,'body bound');
 $moduleDraft=array_replace($draft,['requestId'=>str_repeat('e',32),'category'=>'aplicacao','moduleId'=>'dap:modulo:03','practiceId'=>'dap-m03-s01']);
 $restricted=status($f->call('a','POST','/forum/posts',$moduleDraft),200,'A module application');$restrictedId=$restricted->post->id;
 status($f->call('b','GET','/forum/posts/'.$restrictedId),404,'B cannot read restricted module URL');
 status($f->call('b','POST','/forum/posts/'.$restrictedId.'/comments',array_replace($reply,['requestId'=>str_repeat('f',32)])),404,'B cannot answer restricted module');
 status($f->call('b','POST','/forum/posts',$moduleDraft),403,'B cannot forge course association');
 status($f->call('a','POST','/forum/posts',array_replace($moduleDraft,['requestId'=>str_repeat('f',32),'practiceId'=>'h-arpejos-01'])),400,'mismatched practice rejected');
 status($f->call('a','POST','/forum/posts',array_replace($draft,['space'=>'agd'])),403,'AGD entitlement separate');
 $filter=['space'=>'geral','category'=>'','moduleId'=>'','practiceId'=>'','query'=>'','cursor'=>0];
 $list=status($f->call('b','POST','/forum/list',$filter),200,'B list');ok(count($list->posts)===1&&$list->posts[0]->id===$id,'list excludes unauthorized module');
 $found=status($f->call('a','POST','/forum/list',array_replace($filter,['query'=>'estudo'])),200,'search custom tag');ok(count($found->posts)===1,'tag search');
 $filtered=status($f->call('a','POST','/forum/list',array_replace($filter,['category'=>'equipamentos'])),200,'category filter');ok(count($filtered->posts)===0,'category filter reflects edit');
 status($f->call('a','POST','/forum/list',array_replace($filter,['cursor'=>-1])),400,'pagination bound');
 status($f->call('a','POST','/state/study',['expected_revision'=>0,'data'=>['personalNote'=>'only A']]),200,'save private study');
 $other=status($f->call('b','GET','/state/study'),200,'B study');ok(!isset($other->data->personalNote),'study remains private while forum shared');
 $f->reopen();$persisted=status($f->call('a','GET','/forum/posts/'.$id),200,'new database connection');ok($persisted->post->title===$edit['title']&&count($persisted->comments)===1,'topic and response persist');
 status($f->call('b','POST','/forum/posts/'.$id.'/comments/'.$saved->commentId.'/remove',new stdClass()),200,'B removes own reply');
 $removed=status($f->call('a','GET','/forum/posts/'.$id),200,'reply removal visible');ok($removed->comments[0]->deleted&&$removed->comments[0]->links===[]&&$removed->post->commentCount===0,'removed reply body and links hidden');
 status($f->call('a','POST','/forum/posts/'.$id.'/remove',new stdClass()),200,'A removes own topic');status($f->call('b','GET','/forum/posts/'.$id),404,'removed topic not visible');
// New profile, consent and classifieds checks; entirely synthetic fixtures.
$terms=status($f->call('a','GET','/forum/terms/comunidade'),200,'read full community terms');
ok($terms->acceptedAt!==null&&count($terms->document->sections)===7,'versioned full rules and acceptance available');
$acceptBody=['kind'=>'comunidade','version'=>$terms->document->version,'documentHash'=>$terms->document->hash,'accepted'=>true,'adult'=>false];
$oldTime=$terms->acceptedAt;$accepted=status($f->call('a','POST','/forum/terms/accept',$acceptBody),200,'repeat acceptance');ok($accepted->acceptedAt===$oldTime,'idempotent acceptance keeps first timestamp');
status($f->call('a','POST','/forum/terms/accept',array_replace($acceptBody,['accepted'=>false])),400,'unchecked consent rejected');
status($f->call('a','POST','/forum/terms/accept',array_replace($acceptBody,['version'=>'old'])),409,'outdated version rejected');
status($f->call('a','POST','/forum/terms/accept',array_replace($acceptBody,['documentHash'=>str_repeat('0',64)])),409,'altered document hash rejected');
status($f->call('a','POST','/forum/terms/accept',$acceptBody,['X-CSRF-Token'=>'wrong']),403,'consent requires CSRF');
status($f->call('anon','GET','/forum/terms/comunidade'),401,'terms require account');
status($f->call('none','GET','/forum/terms/comunidade'),403,'terms require app right');

$im=imagecreatetruecolor(40,40);imagefill($im,0,0,imagecolorallocate($im,37,137,172));ob_start();imagepng($im);$png=ob_get_clean();imagedestroy($im);$photo='data:image/png;base64,'.base64_encode($png.'PRIVATE-METADATA-TEST');
$savedPhoto=status($f->call('a','POST','/forum/avatar',['image'=>$photo]),200,'A uploads profile photo');$url=$savedPhoto->profile->avatarUrl;ok(str_starts_with($url,'/api/v1/forum/avatars/'.$a->user->id.'/'),'photo belongs to authenticated author');
$bytes=$f->call('b','GET',substr($url,7));ok($bytes->status===200&&$bytes->headers['Content-Type']==='image/jpeg','B sees A photo as safe raster');$dim=getimagesizefromstring($bytes->body);ok($dim[0]===192&&$dim[1]===192,'photo normalized to 192 square');ok(!str_contains($bytes->body,'PRIVATE-METADATA-TEST'),'metadata and trailing bytes stripped');ok($bytes->headers['Cache-Control']==='private, no-store','private photo not cached');
status($f->call('anon','GET',substr($url,7)),401,'anonymous cannot read photo');status($f->call('none','GET',substr($url,7)),403,'no app cannot read photo');
status($f->call('a','POST','/forum/avatar',['image'=>'data:image/svg+xml;base64,'.base64_encode('<svg onload="alert(1)"/>')]),400,'SVG rejected');
status($f->call('a','POST','/forum/avatar',['image'=>'data:image/png;base64,'.base64_encode('not an image')]),400,'fake image rejected');
status($f->call('a','POST','/forum/avatar',['image'=>str_repeat('x',90001)]),400,'photo bounded');
status($f->call('a','POST','/forum/avatar',['image'=>$photo,'userId'=>$b->user->id]),400,'cannot target another profile');
status($f->call('a','POST','/forum/avatar',['image'=>$photo],['X-CSRF-Token'=>'wrong']),403,'photo requires CSRF');
$im=imagecreatetruecolor(513,1);ob_start();imagepng($im);$wide=ob_get_clean();imagedestroy($im);status($f->call('a','POST','/forum/avatar',['image'=>'data:image/png;base64,'.base64_encode($wide)]),400,'server bounds image dimensions');
$still=status($f->call('a','GET','/forum/options'),200,'profile survives rejected image');ok($still->profile->avatarUrl===$url,'invalid image keeps existing photo');

$filter=['space'=>'trocas','category'=>'','moduleId'=>'','practiceId'=>'','query'=>'','cursor'=>0];
status($f->call('a','POST','/forum/list',$filter),428,'market list blocked without separate consent');
$d=status($f->call('a','GET','/forum/terms/trocas'),200,'read marketplace terms')->document;
$marketAccept=['kind'=>'trocas','version'=>$d->version,'documentHash'=>$d->hash,'accepted'=>true,'adult'=>false];
status($f->call('a','POST','/forum/terms/accept',$marketAccept),400,'adult declaration required');$marketAccept['adult']=true;
status($f->call('a','POST','/forum/terms/accept',$marketAccept),200,'A marketplace acceptance');
$sale=['requestId'=>str_repeat('9',32),'space'=>'trocas','category'=>'equipamentos','title'=>'Troco pedal de teste','body'=>'Anúncio fictício, sem negociação real.','links'=>[],'tags'=>['pedais'],'moduleId'=>'','practiceId'=>''];
$post=status($f->call('a','POST','/forum/posts',$sale),200,'create classifieds post');$saleId=$post->post->id;ok($post->post->author->avatarUrl===$url,'photo attached to post author');
status($f->call('b','GET','/forum/posts/'.$saleId),428,'direct classifieds URL also gated');
status($f->call('b','POST','/forum/posts/'.$saleId.'/comments',['requestId'=>str_repeat('8',32),'body'=>'Interesse','links'=>[]]),428,'reply gated on server');
status($f->call('b','POST','/forum/terms/accept',$marketAccept),200,'B independent marketplace acceptance');
$bPhoto=status($f->call('b','POST','/forum/avatar',['image'=>$photo]),200,'B own photo');
status($f->call('b','POST','/forum/posts/'.$saleId.'/comments',['requestId'=>str_repeat('8',32),'body'=>'Minha resposta fictícia.','links'=>[]]),200,'B replies in classifieds');
$saleRead=status($f->call('a','GET','/forum/posts/'.$saleId),200,'A sees classifieds response');ok($saleRead->comments[0]->author->avatarUrl===$bPhoto->profile->avatarUrl,'reply displays B photo');
status($f->call('a','POST','/forum/posts',array_replace($sale,['requestId'=>str_repeat('7',32),'moduleId'=>'dap:modulo:03'])),400,'classifieds cannot be hidden in a course');
$general=status($f->call('b','POST','/forum/list',array_replace($filter,['space'=>'geral'])),200,'general forum separate');ok(!in_array($saleId,array_map(fn($p)=>$p->id,$general->posts)),'sale not mixed into general feed');
status($f->call('b','POST','/forum/posts/'.$saleId.'/report',['reason'=>'fraude','detail'=>'Denúncia fictícia para QA.']),200,'report stored');
status($f->call('b','POST','/forum/posts/'.$saleId.'/report',['reason'=>'fraude','detail'=>'Mesmo teste.']),200,'report duplicate safe');
status($f->call('b','POST','/forum/posts/'.$saleId.'/report',['reason'=>'wrong','detail'=>'']),400,'report reason checked');
$f->reopen();$persist=status($f->call('a','GET','/forum/options'),200,'profile and consent after database reopen');ok($persist->profile->avatarUrl===$url&&$persist->terms->trocas->acceptedAt!==null,'photo and marketplace consent persist');
$rp=new ReflectionProperty($f,'db');$db=$rp->getValue($f);ok((int)$db->query('SELECT COUNT(*) FROM forum_reports')->fetchColumn()===1,'report is durable and not duplicated');
$evidence=$db->query('SELECT document_json,document_hash FROM forum_acceptances LIMIT 1')->fetch(PDO::FETCH_ASSOC);$record=json_decode($evidence['document_json'],true);ok($record['hash']===$evidence['document_hash']&&count($record['sections'])>0,'accepted document snapshot retained');
status($f->call('a','POST','/forum/avatar',['image'=>null]),200,'remove own photo');status($f->call('b','GET',substr($url,7)),404,'removed photo URL revoked');$after=status($f->call('b','GET','/forum/posts/'.$saleId),200,'topic survives photo removal');ok($after->post->author->avatarUrl===null&&$after->comments[0]->author->avatarUrl!==null,'A removal preserves B photo and conversation');
unset($db,$rp);

 status($f->call('b','POST','/auth/logout',new stdClass()),200,'logout B');status($f->call('b','GET','/forum/options'),401,'logout denies forum');
 echo json_encode(['status'=>'passed','checks'=>$checks,'count'=>count($checks),'database'=>'SQLite file with real existing PHP account services','externalServices'=>false],JSON_PRETTY_PRINT|JSON_UNESCAPED_UNICODE).PHP_EOL;
}finally{$f->close();}
