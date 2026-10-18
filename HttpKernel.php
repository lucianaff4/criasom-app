<?php
declare(strict_types=1);
namespace Criasom;

/** Request parsing is bounded and ignores forwarding headers unless a future trusted-proxy adapter is added. */
final class HttpRequest
{
    public array $headers = [];
    public function __construct(
        public readonly string $method,
        public readonly string $path,
        array $headers = [],
        public readonly array $cookies = [],
        public readonly string $body = '',
        public readonly string $remoteAddress = '192.0.2.1',
        public readonly bool $https = false,
    ) {
        foreach ($headers as $name => $value) {
            if (!is_string($name) || !is_string($value) || preg_match('/[\r\n]/', $name.$value)) throw new \InvalidArgumentException('Invalid headers.');
            $key = strtolower($name);
            if (isset($this->headers[$key])) throw new \InvalidArgumentException('Duplicate header.');
            $this->headers[$key] = $value;
        }
    }
    public function header(string $name): string { return $this->headers[strtolower($name)] ?? ''; }
    public function cookie(string $name): string { return is_string($this->cookies[$name] ?? null) ? $this->cookies[$name] : ''; }
    public static function fromGlobals(): self
    {
        $headers = [];
        foreach ($_SERVER as $name => $value) {
            if (str_starts_with($name, 'HTTP_') && is_string($value)) $headers[strtolower(str_replace('_', '-', substr($name, 5)))] = $value;
        }
        // CGI/CLI-server may expose the same field both as HTTP_CONTENT_TYPE and CONTENT_TYPE.
        // Normalize before constructing HttpRequest; the SAPI's dedicated field is authoritative.
        if (isset($_SERVER['CONTENT_TYPE'])) $headers['content-type'] = (string)$_SERVER['CONTENT_TYPE'];
        $input = fopen('php://input', 'rb');
        if ($input === false) throw new \RuntimeException('Input unavailable.');
        try { $body = stream_get_contents($input, 131073); }
        finally { fclose($input); }
        if ($body === false) throw new \RuntimeException('Input unavailable.');
        return new self((string)($_SERVER['REQUEST_METHOD'] ?? ''), (string)($_SERVER['REQUEST_URI'] ?? ''), $headers, $_COOKIE,
            $body, (string)($_SERVER['REMOTE_ADDR'] ?? ''), in_array($_SERVER['HTTPS'] ?? '', ['on', '1'], true));
    }
}

final class HttpResponse
{
    public function __construct(public readonly int $status, public readonly array $headers, public readonly string $body, public readonly array $cookies = []) {}
    /** Not called by public/index.php: the deployment interlock remains closed. */
    public function emit(): void
    {
        if (headers_sent()) throw new \RuntimeException('Headers already sent.');
        http_response_code($this->status);
        foreach ($this->headers as $name => $value) header($name.': '.$value);
        foreach ($this->cookies as $value) header('Set-Cookie: '.$value, false);
        header('Content-Length: '.strlen($this->body));
        echo $this->body;
    }
}

/** Candidate HTTP adapter around the existing PHP services. No listener or production bootstrap is enabled. */
final class HttpKernel
{
    private const SESSION = '__Host-criasom_session';
    private const CONTEXT = '__Host-criasom_context';
    private const MAX_BODY = 131072;
    public function __construct(private PlatformBackend $backend, private string $origin, private string $key, private string $hotmartToken = '', private ?ForumService $forum = null)
    {
        $parts = parse_url($origin);
        if (strlen($key) !== 32 || !is_array($parts) || ($parts['scheme'] ?? '') !== 'https'
            || empty($parts['host']) || isset($parts['user']) || isset($parts['pass']) || isset($parts['query']) || isset($parts['fragment'])
            || isset($parts['path']) || !preg_match('/^https:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?$/D', $origin)) throw new \InvalidArgumentException('Explicit HTTPS origin and private key required.');
    }
    private function json(int $status, array $data, array $cookies = []): HttpResponse
    {
        return new HttpResponse($status, [
            'Content-Type'=>'application/json; charset=utf-8', 'Cache-Control'=>'private, no-store',
            'Vary'=>'Cookie', 'X-Content-Type-Options'=>'nosniff', 'Referrer-Policy'=>'no-referrer',
            'Cross-Origin-Resource-Policy'=>'same-origin',
        ], json_encode($data, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE), $cookies);
    }
    private function cookie(string $name, string $value, int $age): string
    {
        return $name.'='.$value.'; Max-Age='.$age.'; Path=/; Secure; HttpOnly; SameSite=Lax';
    }
    private function sign(string $text): string { return hash_hmac('sha256', $text, $this->key); }
    private function context(HttpRequest $request, int $now): ?array
    {
        $cookie = $request->cookie(self::CONTEXT);
        if (!preg_match('/^([a-f0-9]{64})\.([0-9]{10,12})\.([a-f0-9]{64})$/D', $cookie, $m)) return null;
        $expires = (int)$m[2]; $payload = $m[1].'.'.$m[2];
        if ($expires <= $now || $expires > $now+1800 || !hash_equals($this->sign('context:'.$payload), $m[3])) return null;
        return ['binding'=>$m[1], 'expires_at'=>$expires, 'csrf'=>$this->sign('anon-csrf:'.$m[1]), 'cookie'=>$cookie];
    }
    private function newContext(int $now, ?string $binding = null): array
    {
        $binding ??= bin2hex(random_bytes(32)); $payload = $binding.'.'.($now+1800);
        return ['binding'=>$binding, 'expires_at'=>$now+1800, 'csrf'=>$this->sign('anon-csrf:'.$binding), 'cookie'=>$payload.'.'.$this->sign('context:'.$payload)];
    }
    private function body(HttpRequest $request, array $fields, array $optional=[]): array
    {
        if (!preg_match('/^application\/json(?:\s*;\s*charset=utf-8)?$/iD', $request->header('content-type'))) throw new PlatformProblem(415, 'json_required');
        try { $object = json_decode($request->body, false, 32, JSON_THROW_ON_ERROR); }
        catch (\JsonException) { throw new PlatformProblem(400, 'invalid_json'); }
        if (!$object instanceof \stdClass) throw new PlatformProblem(400, 'object_required');
        $body = get_object_vars($object); $keys = array_keys($body); sort($keys); sort($fields);
        if (array_diff($keys,array_merge($fields,$optional)) || array_diff($fields,$keys)) throw new PlatformProblem(400, 'invalid_fields');
        return $body;
    }
    private function requireUser(?array $user): array
    {
        if (!$user || ($user['verified'] ?? false) !== true) throw new PlatformProblem(401, 'sign_in_required');
        if (!is_string($user['id'] ?? null) || !preg_match('/^[a-zA-Z0-9_-]{1,80}$/D', $user['id'])
            || !is_string($user['email'] ?? null) || !filter_var($user['email'], FILTER_VALIDATE_EMAIL)
            || !is_string($user['csrf'] ?? null) || !preg_match('/^[a-f0-9]{64}$/D', $user['csrf'])) throw new PlatformProblem(503, 'invalid_session');
        return $user;
    }
    private function checkPost(HttpRequest $request, ?array $user, ?array $context): void
    {
        if ($request->header('origin') !== $this->origin) throw new PlatformProblem(403, 'origin_denied');
        $expected = $user['csrf'] ?? $context['csrf'] ?? null;
        $supplied = $request->header('x-csrf-token');
        if (!is_string($expected) || $supplied === '' || !hash_equals($expected, $supplied)) throw new PlatformProblem(403, 'csrf_denied');
    }
    private function quota(HttpRequest $request, int $now): void
    {
        if (!filter_var($request->remoteAddress, FILTER_VALIDATE_IP)) throw new PlatformProblem(503, 'connection_unavailable');
        // Initial test limits, not a statement of production capacity. REMOTE_ADDR only.
        if (!$this->backend->takeQuota('http-global', 'all', 600, 60, $now)
            || !$this->backend->takeQuota('http-requester', $request->remoteAddress, 120, 60, $now)) throw new PlatformProblem(429, 'try_later');
    }
    public function handle(HttpRequest $request, int $now): HttpResponse
    {
        try {
            if (!$request->https) throw new PlatformProblem(400, 'https_required');
            if (strlen($request->body) > self::MAX_BODY) throw new PlatformProblem(413, 'body_too_large');
            if (!preg_match('#^/api/v1/[a-zA-Z0-9/_-]+$#D', $request->path) || str_contains($request->path, '//')) throw new PlatformProblem(404, 'not_found');
            if (!in_array($request->method, ['GET', 'POST'], true)) throw new PlatformProblem(405, 'method_not_allowed');
            $this->quota($request, $now);
            $route = substr($request->path, 7);
            if ($route === '/webhooks/hotmart') {
                if ($request->method !== 'POST') throw new PlatformProblem(405, 'method_not_allowed');
                if ($this->hotmartToken === '') throw new PlatformProblem(503, 'webhook_not_configured');
                $token = $request->header('x-hotmart-hottok');
                if (!hash_equals($this->hotmartToken, $token)) throw new PlatformProblem(401, 'source_denied');
                if (!preg_match('/^application\/json(?:\s*;\s*charset=utf-8)?$/iD', $request->header('content-type'))) throw new PlatformProblem(415, 'json_required');
                try { $event = HotmartEnvelope::normalize($request->body, $token, $this->hotmartToken); }
                catch (\RuntimeException | \JsonException) { throw new PlatformProblem(400, 'invalid_event'); }
                $result = $this->backend->purchase($event, $now);
                if (!in_array($result['disposition'] ?? null, ['applied', 'duplicate', 'stale', 'review'], true)) throw new PlatformProblem(503, 'purchase_unavailable');
                return $this->json(200, ['accepted'=>true, 'disposition'=>$result['disposition']]);
            }
            if ($request->header('sec-fetch-site') === 'cross-site') throw new PlatformProblem(403, 'origin_denied');
            $sessionToken = $request->cookie(self::SESSION);
            $user = $this->backend->session($sessionToken, $now);
            if ($user !== null) $user = $this->requireUser($user);
            $context = $this->context($request, $now);
            if ($request->method === 'POST') $this->checkPost($request, $user, $context);

            if ($route === '/session') {
                if ($request->method !== 'GET') throw new PlatformProblem(405, 'method_not_allowed');
                if ($user) {
                    $caps = $this->backend->capabilities($user, $now);
                    foreach ($caps as $scope) if (!is_string($scope) || !preg_match('/^(app|repertoire|course:[a-zA-Z0-9_-]+|agd:[a-zA-Z0-9_-]+)$/D', $scope)) throw new PlatformProblem(503, 'invalid_capabilities');
                    return $this->json(200, ['authenticated'=>true, 'user'=>['id'=>$user['id'],'email'=>$user['email']], 'csrf'=>$user['csrf'], 'capabilities'=>array_values($caps)]);
                }
                $cookies = [];
                if ($context === null || $context['expires_at'] < $now+600) { $context = $this->newContext($now, $context['binding'] ?? null); $cookies[] = $this->cookie(self::CONTEXT, $context['cookie'], 1800); }
                if ($sessionToken !== '') $cookies[] = $this->cookie(self::SESSION, '', 0);
                return $this->json(200, ['authenticated'=>false,'csrf'=>$context['csrf'],'capabilities'=>[]], $cookies);
            }
            if ($route === '/auth/request-code' || $route === '/auth/confirm-code') {
                if ($request->method !== 'POST') throw new PlatformProblem(405, 'method_not_allowed');
                if ($user) throw new PlatformProblem(409, 'sign_out_before_switching');
                if ($context === null) throw new PlatformProblem(403, 'context_required');
                if ($route === '/auth/request-code') {
                    $body = $this->body($request, ['email']);
                    if (!is_string($body['email']) || strlen($body['email']) > 254 || !filter_var(trim($body['email']), FILTER_VALIDATE_EMAIL)) throw new PlatformProblem(400, 'invalid_email');
                    // Renew before issuing a 10-minute challenge; keep binding/CSRF stable across tabs.
                    $cookies = [];
                    if ($context['expires_at'] < $now+600) { $context = $this->newContext($now, $context['binding']); $cookies[] = $this->cookie(self::CONTEXT, $context['cookie'], 1800); }
                    $result = $this->backend->requestCode($body['email'], $context['binding'], $request->remoteAddress, $now);
                    if (!is_string($result['challenge_id'] ?? null) || !preg_match('/^[a-f0-9]{32}$/D', $result['challenge_id']) || ($result['expires_in'] ?? null) !== 600) throw new PlatformProblem(503, 'delivery_unavailable');
                    return $this->json(202, ['accepted'=>true,'challenge_id'=>$result['challenge_id'],'expires_in'=>600], $cookies);
                }
                $body = $this->body($request, ['challenge_id', 'code']);
                if (!is_string($body['challenge_id']) || !preg_match('/^[a-f0-9]{32}$/D', $body['challenge_id'])
                    || !is_string($body['code']) || !preg_match('/^[0-9]{8}$/D', $body['code'])) throw new PlatformProblem(400, 'invalid_code_format');
                $result = $this->backend->confirmCode($body['challenge_id'], $body['code'], $context['binding'], $now);
                if ($result === null) throw new PlatformProblem(422, 'invalid_or_expired_code');
                if (!is_string($result['cookie_token'] ?? null) || !preg_match('/^[a-f0-9]{64}$/D', $result['cookie_token'])
                    || !is_int($result['expires_at'] ?? null) || $result['expires_at'] <= $now || $result['expires_at'] > $now+43200) throw new PlatformProblem(503, 'session_unavailable');
                return $this->json(200, ['authenticated'=>true], [
                    $this->cookie(self::SESSION, $result['cookie_token'], $result['expires_at']-$now),
                    $this->cookie(self::CONTEXT, '', 0),
                ]);
            }
            if ($route === '/auth/logout') {
                if ($request->method !== 'POST') throw new PlatformProblem(405, 'method_not_allowed');
                $this->body($request, []); $this->requireUser($user);
                if (!$this->backend->logout($sessionToken, $request->header('x-csrf-token'), $now)) throw new PlatformProblem(503, 'logout_unconfirmed');
                return $this->json(200, ['signed_out'=>true], [$this->cookie(self::SESSION, '', 0), $this->cookie(self::CONTEXT, '', 0)]);
            }
            if (str_starts_with($route, '/forum/')) {
                $user = $this->requireUser($user);
                if ($this->forum === null) throw new PlatformProblem(503, 'forum_not_configured');
                if ($route === '/forum/options' && $request->method === 'GET') return $this->json(200, $this->forum->options($user,$now));
                if (preg_match('#^/forum/terms/(comunidade|trocas)$#D',$route,$m) && $request->method === 'GET') return $this->json(200,$this->forum->terms($user,$m[1],$now));
                if (preg_match('#^/forum/avatars/([a-zA-Z0-9_-]{1,80})/([a-f0-9]{64})$#D',$route,$m) && $request->method === 'GET') return new HttpResponse(200,['Content-Type'=>'image/jpeg','Cache-Control'=>'private, no-store','Vary'=>'Cookie','X-Content-Type-Options'=>'nosniff','Referrer-Policy'=>'no-referrer','Cross-Origin-Resource-Policy'=>'same-origin'],$this->forum->avatar($user,$m[1],$m[2],$now));
                if (preg_match('#^/forum/images/([a-f0-9]{32})/([a-f0-9]{64})$#D',$route,$m) && $request->method === 'GET') return new HttpResponse(200,['Content-Type'=>'image/jpeg','Cache-Control'=>'private, no-store','Vary'=>'Cookie','X-Content-Type-Options'=>'nosniff','Referrer-Policy'=>'no-referrer','Cross-Origin-Resource-Policy'=>'same-origin'],$this->forum->postImage($user,$m[1],$m[2],$now));
                if (preg_match('#^/forum/posts/([a-f0-9]{32})$#D',$route,$m) && $request->method === 'GET') return $this->json(200,$this->forum->get($user,$m[1],$now));
                if ($request->method !== 'POST') throw new PlatformProblem(405,'method_not_allowed');
                if ($route === '/forum/moderation/list') return $this->json(200,$this->forum->moderationQueue($user,$this->body($request,['status','cursor']),$now));
                if ($route === '/forum/moderation/action') return $this->json(200,$this->forum->moderate($user,$this->body($request,['action','targetId','reason','requestId']),$now));
                if ($route === '/forum/images') return $this->json(200,$this->forum->uploadPostImage($user,$this->body($request,['image','requestId']),$now));
                if ($route === '/forum/profile') return $this->json(200,$this->forum->saveProfile($user,$this->body($request,['name'])['name'],$now));
                if ($route === '/forum/avatar') return $this->json(200,$this->forum->saveAvatar($user,$this->body($request,['image'])['image'],$now));
                if ($route === '/forum/terms/accept') return $this->json(200,$this->forum->acceptTerms($user,$this->body($request,['kind','version','documentHash','accepted','adult']),$now));
                if (preg_match('#^/forum/posts/([a-f0-9]{32})/report$#D',$route,$m)) return $this->json(200,$this->forum->report($user,$m[1],$this->body($request,['reason','detail']),$now));
                if ($route === '/forum/list') return $this->json(200,$this->forum->list($user,$this->body($request,['space','category','moduleId','practiceId','query','cursor']),$now));
                if ($route === '/forum/posts') return $this->json(200,$this->forum->create($user,$this->body($request,['requestId','space','category','title','body','links','tags','moduleId','practiceId'],['imageIds']),$now));
                if (preg_match('#^/forum/posts/([a-f0-9]{32})/(edit|remove|comments|comments-list)$#D',$route,$m)) {
                    if ($m[2] === 'edit') return $this->json(200,$this->forum->edit($user,$m[1],$this->body($request,['expectedRevision','category','title','body','links','tags'],['imageIds']),$now));
                    if ($m[2] === 'comments') return $this->json(200,$this->forum->reply($user,$m[1],$this->body($request,['requestId','body','links']),$now));
                    if ($m[2] === 'comments-list') {
                        $body=$this->body($request,['cursor']);
                        if(!is_int($body['cursor'])||$body['cursor']<0||$body['cursor']>10000)throw new PlatformProblem(400,'invalid_forum_cursor');
                        return $this->json(200,$this->forum->get($user,$m[1],$now,$body['cursor']));
                    }
                    $this->body($request,[]);return $this->json(200,$this->forum->remove($user,$m[1],null,$now));
                }
                if (preg_match('#^/forum/posts/([a-f0-9]{32})/comments/([a-f0-9]{32})/remove$#D',$route,$m)) {
                    $this->body($request,[]);return $this->json(200,$this->forum->remove($user,$m[1],$m[2],$now));
                }
                throw new PlatformProblem(404,'not_found');
            }

            if (preg_match('#^/state/(study|repertoire|preferences)$#D', $route, $m)) {
                $user = $this->requireUser($user);
                if ($request->method === 'GET') return $this->json(200, $this->backend->getState($user, $m[1], $now));
                $body = $this->body($request, ['expected_revision','data']);
                if (!is_int($body['expected_revision']) || $body['expected_revision'] < 0 || $body['expected_revision'] >= 9007199254740991
                    || (!is_array($body['data']) && !($body['data'] instanceof \stdClass))) throw new PlatformProblem(400, 'invalid_state');
                $json = json_encode($body['data'], JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
                if (strlen($json) > 65536) throw new PlatformProblem(413, 'state_too_large');
                return $this->json(200, $this->backend->saveState($user, $m[1], $body['expected_revision'], $body['data'], $now));
            }
            if (preg_match('#^/resources/([a-zA-Z0-9_-]{1,80})$#D', $route, $m)) {
                if ($request->method !== 'GET') throw new PlatformProblem(405, 'method_not_allowed');
                $resource = $this->backend->resource($this->requireUser($user), $m[1], $now);
                if ($resource === null) throw new PlatformProblem(404, 'not_found');
                if (!is_string($resource['body'] ?? null) || strlen($resource['body']) > 8388608 || !is_string($resource['headers']['Content-Type'] ?? null)) throw new PlatformProblem(503, 'resource_unavailable');
                return new HttpResponse(200, ResourceGate::headers($resource['headers']['Content-Type']), $resource['body']);
            }
            throw new PlatformProblem(404, 'not_found');
        } catch (PlatformProblem $e) {
            return $this->json($e->status, ['error'=>$e->errorId]);
        } catch (\Throwable) {
            // Internal failures must not leak SQL, keys, paths, codes or purchase payloads.
            return $this->json(503, ['error'=>'service_unavailable']);
        }
    }
}
