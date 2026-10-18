<?php
declare(strict_types=1);
require_once dirname(__DIR__).'/dev/Lab.php';
use Criasom\Dev\Lab;
$dir=__DIR__.'/http-pdo-fixture-'.bin2hex(random_bytes(8));
mkdir($dir,0700);$prior=getenv('CRIASOM_LAB_CONFIG');$checks=[];
try{
 $config=['mode'=>'criasom-synthetic-loopback','httpsPort'=>8543,'phpPort'=>8865,'origin'=>'https://127.0.0.1:8543','proxySecret'=>bin2hex(random_bytes(32)),'syntheticHotmartToken'=>bin2hex(random_bytes(32)),'applicationKeyBase64'=>base64_encode(random_bytes(32))];
 file_put_contents($dir.'/config.json',json_encode($config,JSON_THROW_ON_ERROR));
 putenv('CRIASOM_LAB_CONFIG='.$dir.'/config.json');
 $lab=new Lab(true);
 $assert=function(bool $ok,string $name)use(&$checks){if(!$ok)throw new RuntimeException($name);$checks[]=$name;};
 $assert((int)$lab->db->query('SELECT COUNT(*) FROM users')->fetchColumn()===2,'two synthetic users at fresh initialization');
 $roles=$lab->db->query('SELECT email FROM users JOIN forum_moderators ON users.id=forum_moderators.user_id')->fetchAll(PDO::FETCH_COLUMN);
 $assert($roles===['penta@example.test'],'only intended moderator exists before first login');
 $assert((int)$lab->db->query('SELECT COUNT(*) FROM sessions')->fetchColumn()===0,'initialization does not create authenticated sessions');
 unset($lab);$lab=new Lab(true);
 $assert((int)$lab->db->query('SELECT COUNT(*) FROM users')->fetchColumn()===2,'reinitialization preserves identities');
 $assert((int)$lab->db->query('SELECT COUNT(*) FROM forum_moderators')->fetchColumn()===1,'reinitialization preserves role');
 echo json_encode(['passed'=>count($checks),'checks'=>$checks],JSON_THROW_ON_ERROR);
}finally{
 unset($lab);putenv($prior===false?'CRIASOM_LAB_CONFIG':'CRIASOM_LAB_CONFIG='.$prior);
 foreach(glob($dir.'/*') as $file)unlink($file);rmdir($dir);
}
