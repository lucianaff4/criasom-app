<?php
declare(strict_types=1);
namespace Criasom;

trait ForumModeration
{
    private function isModerator(string $id): bool {return $this->q('SELECT user_id FROM forum_moderators WHERE user_id=?',[$id])->fetchColumn()!==false;}
    private function blockInfo(string $id): ?array
    {$r=$this->q('SELECT reason,updated_at FROM forum_blocks WHERE user_id=? AND active=1',[$id])->fetch(\PDO::FETCH_ASSOC);return $r?['reason'=>$r['reason'],'since'=>(int)$r['updated_at']]:null;}
    private function participating(array $user): void {if($this->blockInfo($user['id']))throw new PlatformProblem(403,'forum_participation_blocked');}
    private function moderator(array $user,int $now): void
    {$this->caps($user,$now);$this->requireTerms($user,'geral');if(!$this->isModerator($user['id']))throw new PlatformProblem(403,'moderator_required');}
    private function moderationPost(string $id,array $user): array
    {
        $r=$this->q('SELECT * FROM forum_posts WHERE id=?',[$id])->fetch(\PDO::FETCH_ASSOC);if(!$r)throw new PlatformProblem(404,'forum_not_found');
        $p=$this->topic($r,$user);$p['removedByAuthor']=$r['deleted_at']!==null;$p['hidden']=$this->q('SELECT post_id FROM forum_hidden WHERE post_id=?',[$id])->fetchColumn()!==false;$p['authorBlocked']=$this->blockInfo($r['author_id'])!==null;$p['authorModerator']=$this->isModerator($r['author_id']);return $p;
    }
    public function moderationQueue(array $user,array $input,int $now): array
    {
        $this->moderator($user,$now);$this->requireTerms($user,'trocas');$cursor=self::cursor($input['cursor']);$state=$input['status'];if(!in_array($state,['pending','resolved','dismissed'],true))throw new PlatformProblem(400,'invalid_report_status');
        $rows=$this->q('SELECT * FROM forum_reports WHERE status=? ORDER BY created_at,id LIMIT 21 OFFSET '.$cursor,[$state])->fetchAll(\PDO::FETCH_ASSOC);
        $reports=[];foreach(array_slice($rows,0,20)as$r){$snapshot=$this->q('SELECT snapshot_json FROM forum_report_snapshots WHERE report_id=?',[$r['id']])->fetchColumn();$reports[]=['id'=>$r['id'],'reason'=>$r['reason'],'detail'=>$r['detail'],'createdAt'=>(int)$r['created_at'],'status'=>$r['status'],'reporter'=>$this->profile($r['reporter_id']),'post'=>$this->moderationPost($r['post_id'],$user),'snapshot'=>$snapshot===false?null:json_decode($snapshot,true,32,JSON_THROW_ON_ERROR)];}
        $ids=$this->q('SELECT id FROM forum_posts ORDER BY created_at DESC,id DESC LIMIT 20')->fetchAll(\PDO::FETCH_COLUMN);
        $blocked=$this->q('SELECT user_id,reason,updated_at FROM forum_blocks WHERE active=1 ORDER BY updated_at DESC LIMIT 100')->fetchAll(\PDO::FETCH_ASSOC);
        $audit=$this->q('SELECT moderator_id,action,target_id,reason,created_at FROM forum_moderation_actions ORDER BY created_at DESC,id DESC LIMIT 30')->fetchAll(\PDO::FETCH_ASSOC);
        $members=$this->q('SELECT user_id FROM forum_profiles UNION SELECT author_id AS user_id FROM forum_posts UNION SELECT author_id AS user_id FROM forum_comments LIMIT 100')->fetchAll(\PDO::FETCH_COLUMN);
        return ['participants'=>array_map(fn($id)=>['profile'=>$this->profile($id),'blocked'=>$this->blockInfo($id)!==null,'moderator'=>$this->isModerator($id)],$members),'reports'=>$reports,'nextCursor'=>count($rows)>20?$cursor+20:null,'pendingCount'=>(int)$this->q("SELECT COUNT(*) FROM forum_reports WHERE status='pending'")->fetchColumn(),'recentPosts'=>array_map(fn($id)=>$this->moderationPost($id,$user),$ids),'blocked'=>array_map(fn($b)=>['profile'=>$this->profile($b['user_id']),'reason'=>$b['reason'],'since'=>(int)$b['updated_at']],$blocked),'audit'=>array_map(fn($a)=>['moderator'=>$this->profile($a['moderator_id']),'action'=>$a['action'],'targetId'=>$a['target_id'],'reason'=>$a['reason'],'at'=>(int)$a['created_at']],$audit)];
    }
    public function moderate(array $user,array $input,int $now): array
    {
        $this->moderator($user,$now);$action=$input['action'];if(!in_array($action,['hide','restore','block','unblock','resolve','dismiss'],true))throw new PlatformProblem(400,'invalid_moderation_action');
        $id=self::text($input['targetId'],80,true);$reason=self::text($input['reason'],500,true);$request=self::requestId($input['requestId']);$hash=hash('sha256',json_encode([$action,$id,$reason],JSON_THROW_ON_ERROR));
        $old=$this->q('SELECT request_hash FROM forum_moderation_actions WHERE moderator_id=? AND request_id=?',[$user['id'],$request])->fetchColumn();if($old!==false){if(!hash_equals($old,$hash))throw new PlatformProblem(409,'forum_request_conflict');return ['saved'=>true,'repeated'=>true];}
        $this->writeQuota($user,$now);$this->db->beginTransaction();
        try{
            if(in_array($action,['hide','restore'],true)){
                $p=$this->q('SELECT id,deleted_at FROM forum_posts WHERE id=?',[$id])->fetch(\PDO::FETCH_ASSOC);if(!$p)throw new PlatformProblem(404,'forum_not_found');
                if($action==='hide'){$sql=$this->db->getAttribute(\PDO::ATTR_DRIVER_NAME)==='sqlite'?'INSERT OR IGNORE':'INSERT IGNORE';$this->q($sql.' INTO forum_hidden(post_id,moderator_id,reason,created_at) VALUES (?,?,?,?)',[$id,$user['id'],$reason,$now]);}
                else{if($p['deleted_at']!==null)throw new PlatformProblem(409,'author_removed_post');$this->q('DELETE FROM forum_hidden WHERE post_id=?',[$id]);}
            }elseif(in_array($action,['block','unblock'],true)){
                if($id===$user['id']||$this->isModerator($id))throw new PlatformProblem(403,'cannot_block_moderator');
                if($this->q('SELECT id FROM users WHERE id=?',[$id])->fetchColumn()===false)throw new PlatformProblem(404,'user_not_found');
                $sql=$this->db->getAttribute(\PDO::ATTR_DRIVER_NAME)==='sqlite'?'INSERT INTO forum_blocks(user_id,active,reason,moderator_id,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET active=excluded.active,reason=excluded.reason,moderator_id=excluded.moderator_id,updated_at=excluded.updated_at':'INSERT INTO forum_blocks(user_id,active,reason,moderator_id,updated_at) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE active=VALUES(active),reason=VALUES(reason),moderator_id=VALUES(moderator_id),updated_at=VALUES(updated_at)';
                $this->q($sql,[$id,$action==='block'?1:0,$reason,$user['id'],$now]);
            }else{
                if($this->q('SELECT id FROM forum_reports WHERE id=?',[$id])->fetchColumn()===false)throw new PlatformProblem(404,'report_not_found');
                $this->q('UPDATE forum_reports SET status=? WHERE id=?',[$action==='resolve'?'resolved':'dismissed',$id]);
            }
            $this->q('INSERT INTO forum_moderation_actions(id,moderator_id,request_id,request_hash,action,target_id,reason,created_at) VALUES (?,?,?,?,?,?,?,?)',[bin2hex(random_bytes(16)),$user['id'],$request,$hash,$action,$id,$reason,$now]);$this->db->commit();
        }catch(\Throwable $e){if($this->db->inTransaction())$this->db->rollBack();throw $e;}return ['saved'=>true,'repeated'=>false];
    }
    private function postImages(string $id): array
    {$rows=$this->q('SELECT id,version,width,height FROM forum_images WHERE post_id=? ORDER BY position,id',[$id])->fetchAll(\PDO::FETCH_ASSOC);return array_map(fn($r)=>['id'=>$r['id'],'url'=>'/api/v1/forum/images/'.$r['id'].'/'.$r['version'],'width'=>(int)$r['width'],'height'=>(int)$r['height']],$rows);}
    private function imageIds(mixed $value): array
    {if(!is_array($value)||!array_is_list($value)||count($value)>3||count(array_unique($value,SORT_REGULAR))!==count($value))throw new PlatformProblem(400,'invalid_post_images');foreach($value as$id)if(!is_string($id)||!preg_match('/^[a-f0-9]{32}$/D',$id))throw new PlatformProblem(400,'invalid_post_images');return $value;}
    private function attachImages(array $user,string $postId,array $ids,int $now): void
    {
        foreach($ids as$id){$r=$this->q('SELECT owner_id,post_id,created_at FROM forum_images WHERE id=?',[$id])->fetch(\PDO::FETCH_ASSOC);if(!$r||$r['owner_id']!==$user['id']||($r['post_id']!==null&&$r['post_id']!==$postId)||($r['post_id']===null&&(int)$r['created_at']<$now-86400))throw new PlatformProblem(400,'invalid_post_images');}
        $this->q('UPDATE forum_images SET post_id=NULL WHERE post_id=?',[$postId]);foreach($ids as$position=>$id)$this->q('UPDATE forum_images SET post_id=?,position=? WHERE id=?',[$postId,$position,$id]);
    }
    public function uploadPostImage(array $user,array $input,int $now): array
    {
        $this->caps($user,$now);$this->requireTerms($user,'geral');$request=self::requestId($input['requestId']);$value=$input['image'];
        if(!is_string($value)||strlen($value)>110000||!preg_match('#^data:image/(jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$#D',$value,$m))throw new PlatformProblem(400,'invalid_post_image');
        $raw=base64_decode($m[2],true);if($raw===false||strlen($raw)>80000)throw new PlatformProblem(400,'invalid_post_image');$size=@getimagesizefromstring($raw);
        if(!$size||!in_array($size[2],[IMAGETYPE_JPEG,IMAGETYPE_PNG],true)||$size[0]<1||$size[1]<1||$size[0]>1600||$size[1]>1600||($m[1]==='jpeg')!==($size[2]===IMAGETYPE_JPEG))throw new PlatformProblem(400,'invalid_post_image');
        $hash=hash('sha256',$raw);$existing=$this->q('SELECT id,request_hash,version,width,height FROM forum_images WHERE owner_id=? AND request_id=?',[$user['id'],$request])->fetch(\PDO::FETCH_ASSOC);
        if($existing){if(!hash_equals($hash,$existing['request_hash']))throw new PlatformProblem(409,'forum_request_conflict');return ['image'=>['id'=>$existing['id'],'url'=>'/api/v1/forum/images/'.$existing['id'].'/'.$existing['version'],'width'=>(int)$existing['width'],'height'=>(int)$existing['height']]];}
        if((int)$this->q('SELECT COUNT(*) FROM forum_images WHERE owner_id=?',[$user['id']])->fetchColumn()>=500)throw new PlatformProblem(429,'image_storage_limit');
        $this->writeQuota($user,$now);if(!function_exists('imagecreatefromstring'))throw new PlatformProblem(503,'image_processing_unavailable');$source=@imagecreatefromstring($raw);if(!$source)throw new PlatformProblem(400,'invalid_post_image');
        $factor=min(1,1280/max($size[0],$size[1]));$w=max(1,(int)round($size[0]*$factor));$h=max(1,(int)round($size[1]*$factor));$canvas=imagecreatetruecolor($w,$h);imagefill($canvas,0,0,imagecolorallocate($canvas,255,255,255));imagecopyresampled($canvas,$source,0,0,0,0,$w,$h,$size[0],$size[1]);
        foreach([82,65,45]as$quality){ob_start();imagejpeg($canvas,null,$quality);$jpeg=ob_get_clean();if(strlen($jpeg)<=80000)break;}imagedestroy($source);imagedestroy($canvas);if(strlen($jpeg)>80000)throw new PlatformProblem(400,'invalid_post_image');
        $id=bin2hex(random_bytes(16));$version=hash('sha256',$jpeg);$this->q('INSERT INTO forum_images(id,owner_id,request_id,request_hash,jpeg_base64,version,width,height,created_at,position) VALUES (?,?,?,?,?,?,?,?,?,0)',[$id,$user['id'],$request,$hash,base64_encode($jpeg),$version,$w,$h,$now]);return ['image'=>['id'=>$id,'url'=>'/api/v1/forum/images/'.$id.'/'.$version,'width'=>$w,'height'=>$h]];
    }
    public function postImage(array $user,string $id,string $version,int $now): string
    {
        $this->caps($user,$now);$this->requireTerms($user,'geral');$r=$this->q('SELECT * FROM forum_images WHERE id=? AND version=?',[$id,$version])->fetch(\PDO::FETCH_ASSOC);if(!$r)throw new PlatformProblem(404,'image_not_found');
        if($r['post_id']===null){if($r['owner_id']!==$user['id']||(int)$r['created_at']<$now-86400)throw new PlatformProblem(404,'image_not_found');}
        elseif(!$this->isModerator($user['id']))$this->post($user,$r['post_id'],$now);
        else{$p=$this->q('SELECT space FROM forum_posts WHERE id=?',[$r['post_id']])->fetchColumn();if($p===false)throw new PlatformProblem(404,'image_not_found');$this->requireTerms($user,$p);}
        return base64_decode($r['jpeg_base64'],true);
    }
}
