<?php
declare(strict_types=1);
namespace Criasom;

use PDO;
require_once __DIR__.'/ForumProfileTerms.php';
require_once __DIR__.'/ForumModeration.php';

/** Shared forum; identity and current entitlements come exclusively from the account backend. */
final class ForumService
{
    use ForumProfileTerms;
    use ForumModeration;
    public const CATEGORIES = ['conversas'=>'Conversas livres','equipamentos'=>'Equipamentos','musicas'=>'Músicas e repertório','recomendacoes'=>'Recomendações','aplicacao'=>'Aplicação dos estudos','duvidas'=>'Dúvidas','criacao'=>'Composição e criação','rotina'=>'Rotina de estudo'];
    private array $modules = [];
    public function __construct(private PDO $db, private PlatformBackend $accounts, array $modules)
    {
        foreach ($modules as $m) $this->modules[$m['id']] = ['id'=>$m['id'],'courseId'=>$m['courseId'],'title'=>$m['title'],
            'practices'=>array_map(static fn($p)=>['id'=>$p['id'],'title'=>$p['displayTitle']??$p['title']],$m['practices']??[])];
    }
    private function q(string $sql, array $args=[]): \PDOStatement {$q=$this->db->prepare($sql);$q->execute($args);return $q;}
    private function caps(array $user,int $now): array
    {
        $caps=$this->accounts->capabilities($user,$now);
        if(!in_array('app',$caps,true))throw new PlatformProblem(403,'forum_access_denied');
        return $caps;
    }
    private function space(mixed $space,array $caps): string
    {
        if(!in_array($space,['geral','agd','trocas'],true))throw new PlatformProblem(400,'invalid_forum_space');
        if($space==='agd'&&!in_array('agd:challenges',$caps,true))throw new PlatformProblem(403,'forum_access_denied');
        return $space;
    }
    private static function text(mixed $value,int $max,bool $required=false): string
    {
        if(!is_string($value)||!preg_match('//u',$value)||preg_match('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/',$value))throw new PlatformProblem(400,'invalid_forum_text');
        $value=trim($value);
        if(preg_match_all('/./us',$value)>$max||($required&&$value===''))throw new PlatformProblem(400,'invalid_forum_text');
        return $value;
    }
    private static function links(mixed $links): array
    {
        if(!is_array($links)||!array_is_list($links)||count($links)>5)throw new PlatformProblem(400,'invalid_forum_links');
        $out=[];
        foreach($links as $url){
            $url=self::text($url,2048,true);$parts=parse_url($url);
            if(!$parts||!in_array(strtolower($parts['scheme']??''),['http','https'],true)||empty($parts['host'])||isset($parts['user'])||isset($parts['pass'])
                ||preg_match('/[\s\\\\]/u',$url)||!filter_var($url,FILTER_VALIDATE_URL))throw new PlatformProblem(400,'invalid_forum_links');
            $out[]=$url;
        }
        return array_values(array_unique($out)); // No fetching, embedding or previewing arbitrary URLs on the server.
    }
    private static function tags(mixed $tags): array
    {
        if(!is_array($tags)||!array_is_list($tags)||count($tags)>5)throw new PlatformProblem(400,'invalid_forum_tags');
        return array_values(array_unique(array_map(static fn($t)=>self::text($t,30,true),$tags)));
    }
    private static function category(mixed $value): string
    {if(!is_string($value)||!isset(self::CATEGORIES[$value]))throw new PlatformProblem(400,'invalid_forum_category');return $value;}
    private static function requestId(mixed $value): string
    {if(!is_string($value)||!preg_match('/^[a-f0-9]{32}$/D',$value))throw new PlatformProblem(400,'invalid_forum_request');return $value;}
    private static function cursor(mixed $value): int
    {if(!is_int($value)||$value<0||$value>10000)throw new PlatformProblem(400,'invalid_forum_cursor');return $value;}
    private function relation(mixed $moduleId,mixed $practiceId,array $caps): array
    {
        if(!is_string($moduleId)||!is_string($practiceId))throw new PlatformProblem(400,'invalid_forum_relation');
        if($moduleId===''){if($practiceId!=='')throw new PlatformProblem(400,'invalid_forum_relation');return ['',''];}
        $module=$this->modules[$moduleId]??null;
        if(!$module||!in_array('course:'.$module['courseId'],$caps,true))throw new PlatformProblem(403,'forum_access_denied');
        if($practiceId!==''&&!in_array($practiceId,array_column($module['practices'],'id'),true))throw new PlatformProblem(400,'invalid_forum_relation');
        return [$moduleId,$practiceId];
    }
    private function profile(string $id): array
    {
        $name=$this->q('SELECT display_name FROM forum_profiles WHERE user_id=?',[$id])->fetchColumn();
        $photo=$this->q('SELECT version FROM forum_avatars WHERE user_id=?',[$id])->fetchColumn();
        return ['id'=>$id,'name'=>$name===false?'Aluno '.substr($id,0,6):$name,'avatarUrl'=>$photo===false?null:'/api/v1/forum/avatars/'.$id.'/'.$photo];
    }
    private function topic(array $r,array $user): array
    {
        $module=$this->modules[$r['module_id']]??null;
        return ['id'=>$r['id'],'author'=>$this->profile($r['author_id']),'own'=>$r['author_id']===$user['id'],
            'space'=>$r['space'],'category'=>$r['category'],'title'=>$r['title'],'body'=>$r['body'],
            'images'=>$this->postImages($r['id']),'links'=>json_decode($r['links_json'],true,8,JSON_THROW_ON_ERROR),'tags'=>json_decode($r['tags_json'],true,8,JSON_THROW_ON_ERROR),
            'moduleId'=>$r['module_id'],'practiceId'=>$r['practice_id'],'module'=>$module,
            'revision'=>(int)$r['revision'],'createdAt'=>(int)$r['created_at'],'updatedAt'=>(int)$r['updated_at'],
            'commentCount'=>(int)($r['comment_count']??$this->q('SELECT COUNT(*) FROM forum_comments WHERE post_id=? AND deleted_at IS NULL',[$r['id']])->fetchColumn())];
    }
    private function post(array $user,string $id,int $now): array
    {
        $caps=$this->caps($user,$now);
        $r=$this->q('SELECT * FROM forum_posts WHERE id=? AND deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM forum_hidden h WHERE h.post_id=forum_posts.id)',[$id])->fetch(PDO::FETCH_ASSOC);
        if(!$r)throw new PlatformProblem(404,'forum_not_found');
        try{$this->space($r['space'],$caps);$this->relation($r['module_id'],$r['practice_id'],$caps);}
        catch(PlatformProblem){throw new PlatformProblem(404,'forum_not_found');}
        $this->requireTerms($user,$r['space']);return $r;
    }
    public function options(array $user,int $now): array
    {
        $caps=$this->caps($user,$now);
        return ['moderator'=>$this->isModerator($user['id']),'blocked'=>$this->blockInfo($user['id']),'categories'=>self::CATEGORIES,'profile'=>$this->profile($user['id']),'spaces'=>in_array('agd:challenges',$caps,true)?['geral','trocas','agd']:['geral','trocas'],
            'terms'=>['comunidade'=>['acceptedAt'=>$this->accepted($user['id'],'comunidade')],'trocas'=>['acceptedAt'=>$this->accepted($user['id'],'trocas')]],
            'modules'=>array_values(array_filter($this->modules,static fn($m)=>in_array('course:'.$m['courseId'],$caps,true)))];
    }
    public function saveProfile(array $user,mixed $name,int $now): array
    {
        $this->caps($user,$now);$this->participating($user);$name=self::text($name,60,true);$this->writeQuota($user,$now);
        $sql=$this->db->getAttribute(PDO::ATTR_DRIVER_NAME)==='sqlite'
            ?'INSERT INTO forum_profiles(user_id,display_name) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name'
            :'INSERT INTO forum_profiles(user_id,display_name) VALUES (?,?) ON DUPLICATE KEY UPDATE display_name=VALUES(display_name)';
        $this->q($sql,[$user['id'],$name]);return ['profile'=>$this->profile($user['id'])];
    }
    public function list(array $user,array $input,int $now): array
    {
        $caps=$this->caps($user,$now);$space=$this->space($input['space'],$caps);$cursor=self::cursor($input['cursor']);$this->requireTerms($user,$space);
        $category=$input['category']===''?'':self::category($input['category']);
        [$module,$practice]=$this->relation($input['moduleId'],$input['practiceId'],$caps);$query=self::text($input['query'],100);if($space==='trocas'&&($module!==''||$practice!==''))throw new PlatformProblem(400,'marketplace_module_not_allowed');
        $allowed=array_keys(array_filter($this->modules,static fn($m)=>in_array('course:'.$m['courseId'],$caps,true)));
        $where="p.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM forum_hidden h WHERE h.post_id=p.id) AND p.space=? AND (p.module_id=''"; $params=[$space];
        if($allowed){$where.=' OR p.module_id IN ('.implode(',',array_fill(0,count($allowed),'?')).')';$params=array_merge($params,$allowed);}$where.=')';
        foreach(['category'=>$category,'module_id'=>$module,'practice_id'=>$practice] as $key=>$value)if($value!==''){$where.=' AND p.'.$key.'=?';$params[]=$value;}
        if($query!==''){$where.=" AND (p.title LIKE ? ESCAPE '!' OR p.body LIKE ? ESCAPE '!' OR p.tags_json LIKE ? ESCAPE '!')";$term='%'.str_replace(['!','%','_'],['!!','!%','!_'],$query).'%';array_push($params,$term,$term,$term);}
        $rows=$this->q('SELECT p.*,(SELECT COUNT(*) FROM forum_comments c WHERE c.post_id=p.id AND c.deleted_at IS NULL) AS comment_count FROM forum_posts p WHERE '.$where.' ORDER BY p.activity_at DESC,p.id DESC LIMIT 21 OFFSET '.$cursor,$params)->fetchAll(PDO::FETCH_ASSOC);
        return ['posts'=>array_map(fn($r)=>$this->topic($r,$user),array_slice($rows,0,20)),'nextCursor'=>count($rows)>20?$cursor+20:null];
    }
    public function get(array $user,string $id,int $now,int $cursor=0): array
    {
        $r=$this->post($user,$id,$now);$cursor=self::cursor($cursor);
        $rows=$this->q('SELECT * FROM forum_comments WHERE post_id=? ORDER BY created_at,id LIMIT 21 OFFSET '.$cursor,[$id])->fetchAll(PDO::FETCH_ASSOC);
        return ['post'=>$this->topic($r,$user),'comments'=>array_map(fn($c)=>['id'=>$c['id'],'author'=>$this->profile($c['author_id']),'own'=>$c['author_id']===$user['id'],
            'body'=>$c['deleted_at']===null?$c['body']:'Resposta removida pelo autor.','links'=>$c['deleted_at']===null?json_decode($c['links_json'],true,8,JSON_THROW_ON_ERROR):[],
            'deleted'=>$c['deleted_at']!==null,'createdAt'=>(int)$c['created_at']],array_slice($rows,0,20)),'nextCursor'=>count($rows)>20?$cursor+20:null];
    }
    private function content(array $input): array
    {return ['title'=>self::text($input['title'],160,true),'body'=>self::text($input['body'],6000),'category'=>self::category($input['category']),'links'=>self::links($input['links']),'tags'=>self::tags($input['tags'])];}
    private function writeQuota(array $user,int $now): void
    {if(!$this->accounts->takeQuota('forum-write',$user['id'],20,60,$now))throw new PlatformProblem(429,'try_later');}
    public function create(array $user,array $input,int $now): array
    {
        $caps=$this->caps($user,$now);$space=$this->space($input['space'],$caps);[$module,$practice]=$this->relation($input['moduleId'],$input['practiceId'],$caps);
        $this->requireTerms($user,$space);if($space==='trocas'&&($module!==''||$practice!==''))throw new PlatformProblem(400,'marketplace_module_not_allowed');
        $request=self::requestId($input['requestId']);$c=$this->content($input);$images=$this->imageIds($input['imageIds']??[]);$signature=[$space,$module,$practice,$c];if($images)$signature[]=$images;$hash=hash('sha256',json_encode($signature,JSON_THROW_ON_ERROR));
        $existing=$this->q('SELECT id,request_hash FROM forum_posts WHERE author_id=? AND request_id=?',[$user['id'],$request])->fetch(PDO::FETCH_ASSOC);
        if($existing){if(!hash_equals($existing['request_hash'],$hash))throw new PlatformProblem(409,'forum_request_conflict');return $this->get($user,$existing['id'],$now);}
        $this->writeQuota($user,$now);$id=bin2hex(random_bytes(16));$this->db->beginTransaction();try{
        $this->q('INSERT INTO forum_posts(id,author_id,request_id,request_hash,space,category,title,body,links_json,tags_json,module_id,practice_id,revision,created_at,updated_at,activity_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)',
            [$id,$user['id'],$request,$hash,$space,$c['category'],$c['title'],$c['body'],json_encode($c['links']),json_encode($c['tags']),$module,$practice,$now,$now,$now]);
        $this->attachImages($user,$id,$images,$now);$this->db->commit();}catch(\Throwable $e){if($this->db->inTransaction())$this->db->rollBack();throw $e;}
        return $this->get($user,$id,$now);
    }
    public function edit(array $user,string $id,array $input,int $now): array
    {
        $post=$this->post($user,$id,$now);if($post['author_id']!==$user['id'])throw new PlatformProblem(403,'forum_owner_required');
        if(!is_int($input['expectedRevision'])||$input['expectedRevision']<1)throw new PlatformProblem(400,'invalid_revision');
        $c=$this->content($input);$images=$this->imageIds($input['imageIds']??array_column($this->postImages($id),'id'));$this->writeQuota($user,$now);$this->db->beginTransaction();try{
        $count=$this->q('UPDATE forum_posts SET title=?,body=?,category=?,links_json=?,tags_json=?,revision=revision+1,updated_at=? WHERE id=? AND author_id=? AND revision=? AND deleted_at IS NULL',
            [$c['title'],$c['body'],$c['category'],json_encode($c['links']),json_encode($c['tags']),$now,$id,$user['id'],$input['expectedRevision']])->rowCount();
        if($count!==1)throw new PlatformProblem(409,'forum_revision_conflict');$this->attachImages($user,$id,$images,$now);$this->db->commit();}catch(\Throwable $e){if($this->db->inTransaction())$this->db->rollBack();throw $e;}return $this->get($user,$id,$now);
    }
    public function reply(array $user,string $id,array $input,int $now): array
    {
        $this->post($user,$id,$now);$body=self::text($input['body'],4000);$links=self::links($input['links']);if($body===''&&!$links)throw new PlatformProblem(400,'empty_forum_reply');
        $request=self::requestId($input['requestId']);$hash=hash('sha256',json_encode([$id,$body,$links],JSON_THROW_ON_ERROR));
        $existing=$this->q('SELECT id,request_hash FROM forum_comments WHERE author_id=? AND request_id=?',[$user['id'],$request])->fetch(PDO::FETCH_ASSOC);
        if($existing){if(!hash_equals($existing['request_hash'],$hash))throw new PlatformProblem(409,'forum_request_conflict');return ['saved'=>true,'commentId'=>$existing['id']];}
        $this->writeQuota($user,$now);$commentId=bin2hex(random_bytes(16));
        $this->db->beginTransaction();
        try{
            $count=$this->q('UPDATE forum_posts SET activity_at=?,revision=revision+1 WHERE id=? AND deleted_at IS NULL',[$now,$id])->rowCount();
            if($count!==1)throw new PlatformProblem(404,'forum_not_found');
            $this->q('INSERT INTO forum_comments(id,post_id,author_id,request_id,request_hash,body,links_json,created_at) VALUES (?,?,?,?,?,?,?,?)',[$commentId,$id,$user['id'],$request,$hash,$body,json_encode($links),$now]);
            $this->db->commit();
        }catch(\Throwable $e){if($this->db->inTransaction())$this->db->rollBack();throw $e;}
        return ['saved'=>true,'commentId'=>$commentId];
    }
    public function remove(array $user,string $id,?string $commentId,int $now): array
    {
        $post=$this->post($user,$id,$now);
        if($commentId===null){
            if($post['author_id']!==$user['id'])throw new PlatformProblem(403,'forum_owner_required');
            $this->q('UPDATE forum_posts SET deleted_at=?,revision=revision+1 WHERE id=? AND author_id=?',[$now,$id,$user['id']]);
        }else{
            $r=$this->q('SELECT author_id FROM forum_comments WHERE id=? AND post_id=?',[$commentId,$id])->fetch(PDO::FETCH_ASSOC);
            if(!$r)throw new PlatformProblem(404,'forum_not_found');if($r['author_id']!==$user['id'])throw new PlatformProblem(403,'forum_owner_required');
            $this->q('UPDATE forum_comments SET deleted_at=? WHERE id=? AND post_id=? AND author_id=?',[$now,$commentId,$id,$user['id']]);
        }
        return ['removed'=>true]; // Soft deletion preserves the local evidence; no destructive cascade.
    }
}
