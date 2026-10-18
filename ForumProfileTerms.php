<?php
declare(strict_types=1);
namespace Criasom;
require_once __DIR__.'/ForumTerms.php';

trait ForumProfileTerms
{
    private function accepted(string $id,string $kind): ?int
    {
        $d=ForumTerms::document($kind);$value=$this->q('SELECT accepted_at FROM forum_acceptances WHERE user_id=? AND kind=? AND version=? AND document_hash=?',[$id,$kind,$d['version'],$d['hash']])->fetchColumn();return $value===false?null:(int)$value;
    }
    private function requireTerms(array $user,string $space): void
    {
        $this->participating($user);if($this->accepted($user['id'],'comunidade')===null)throw new PlatformProblem(428,'community_terms_required');
        if($space==='trocas'&&$this->accepted($user['id'],'trocas')===null)throw new PlatformProblem(428,'marketplace_terms_required');
    }
    public function terms(array $user,string $kind,int $now): array
    {
        $this->caps($user,$now);return ['document'=>ForumTerms::document($kind),'acceptedAt'=>$this->accepted($user['id'],$kind)];
    }
    public function acceptTerms(array $user,array $input,int $now): array
    {
        $this->caps($user,$now);if(!is_string($input['kind']))throw new PlatformProblem(400,'invalid_terms_kind');$d=ForumTerms::document($input['kind']);
        if($input['accepted']!==true||!is_bool($input['adult'])||($d['kind']==='trocas'&&$input['adult']!==true))throw new PlatformProblem(400,'terms_consent_required');
        if($input['version']!==$d['version']||$input['documentHash']!==$d['hash'])throw new PlatformProblem(409,'terms_version_changed');
        if($d['kind']==='trocas')$this->requireTerms($user,'geral');
        $old=$this->accepted($user['id'],$d['kind']);if($old!==null)return ['accepted'=>true,'kind'=>$d['kind'],'version'=>$d['version'],'acceptedAt'=>$old];
        $this->writeQuota($user,$now);$sql=$this->db->getAttribute(\PDO::ATTR_DRIVER_NAME)==='sqlite'?'INSERT OR IGNORE':'INSERT IGNORE';
        $this->q($sql.' INTO forum_acceptances(user_id,kind,version,document_hash,document_json,accepted_at,adult_declared) VALUES (?,?,?,?,?,?,?)',[$user['id'],$d['kind'],$d['version'],$d['hash'],json_encode($d,JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR),$now,$input['adult']?1:0]);
        return ['accepted'=>true,'kind'=>$d['kind'],'version'=>$d['version'],'acceptedAt'=>$this->accepted($user['id'],$d['kind'])];
    }
    public function saveAvatar(array $user,mixed $value,int $now): array
    {
        $this->caps($user,$now);$this->participating($user);$this->writeQuota($user,$now);
        if($value===null){$this->q('DELETE FROM forum_avatars WHERE user_id=?',[$user['id']]);return ['profile'=>$this->profile($user['id'])];}
        if(!is_string($value)||strlen($value)>90000||!preg_match('#^data:image/(jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$#D',$value,$m))throw new PlatformProblem(400,'invalid_avatar');
        $raw=base64_decode($m[2],true);if($raw===false||strlen($raw)>65536)throw new PlatformProblem(400,'invalid_avatar');
        $size=@getimagesizefromstring($raw);
        if(!$size||!in_array($size[2],[IMAGETYPE_JPEG,IMAGETYPE_PNG],true)||$size[0]<1||$size[1]<1||$size[0]>512||$size[1]>512||($m[1]==='jpeg')!==($size[2]===IMAGETYPE_JPEG))throw new PlatformProblem(400,'invalid_avatar');
        if(!function_exists('imagecreatefromstring'))throw new PlatformProblem(503,'avatar_processing_unavailable');
        $source=@imagecreatefromstring($raw);if(!$source)throw new PlatformProblem(400,'invalid_avatar');
        $canvas=imagecreatetruecolor(192,192);imagefill($canvas,0,0,imagecolorallocate($canvas,255,255,255));
        $edge=min($size[0],$size[1]);imagecopyresampled($canvas,$source,0,0,(int)(($size[0]-$edge)/2),(int)(($size[1]-$edge)/2),192,192,$edge,$edge);
        ob_start();imagejpeg($canvas,null,82);$jpeg=ob_get_clean();imagedestroy($source);imagedestroy($canvas);
        if(!is_string($jpeg)||strlen($jpeg)>65536)throw new PlatformProblem(400,'invalid_avatar');
        $version=hash('sha256',$jpeg);$sql=$this->db->getAttribute(\PDO::ATTR_DRIVER_NAME)==='sqlite'
            ?'INSERT INTO forum_avatars(user_id,jpeg_base64,version) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET jpeg_base64=excluded.jpeg_base64,version=excluded.version'
            :'INSERT INTO forum_avatars(user_id,jpeg_base64,version) VALUES (?,?,?) ON DUPLICATE KEY UPDATE jpeg_base64=VALUES(jpeg_base64),version=VALUES(version)';
        $this->q($sql,[$user['id'],base64_encode($jpeg),$version]);return ['profile'=>$this->profile($user['id'])];
    }
    public function avatar(array $user,string $owner,string $version,int $now): string
    {
        $this->caps($user,$now);$this->requireTerms($user,'geral');$photo=$this->q('SELECT jpeg_base64 FROM forum_avatars WHERE user_id=? AND version=?',[$owner,$version])->fetchColumn();
        if($photo===false)throw new PlatformProblem(404,'avatar_not_found');return base64_decode($photo,true);
    }
    public function report(array $user,string $postId,array $input,int $now): array
    {
        $reportedPost=$this->post($user,$postId,$now);$reason=$input['reason'];if(!in_array($reason,['fraude','identidade','abuso','spam','outro'],true))throw new PlatformProblem(400,'invalid_report_reason');
        $detail=self::text($input['detail'],1000);$this->writeQuota($user,$now);$sql=$this->db->getAttribute(\PDO::ATTR_DRIVER_NAME)==='sqlite'?'INSERT OR IGNORE':'INSERT IGNORE';
        $this->db->beginTransaction();try{$this->q($sql.' INTO forum_reports(id,post_id,reporter_id,reason,detail,created_at,status) VALUES (?,?,?,?,?,?,?)',[bin2hex(random_bytes(16)),$postId,$user['id'],$reason,$detail,$now,'pending']);
        $reportId=$this->q('SELECT id FROM forum_reports WHERE post_id=? AND reporter_id=?',[$postId,$user['id']])->fetchColumn();$this->q($sql.' INTO forum_report_snapshots(report_id,snapshot_json) VALUES (?,?)',[$reportId,json_encode(['title'=>$reportedPost['title'],'body'=>$reportedPost['body'],'links'=>json_decode($reportedPost['links_json'],true),'at'=>$now],JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR)]);$this->db->commit();}catch(\Throwable $e){if($this->db->inTransaction())$this->db->rollBack();throw $e;}
        return ['recorded'=>true,'delivery'=>'local_moderation_queue','message'=>'Denúncia registrada no painel de moderação deste teste local. Não há notificação externa.'];
    }
}
