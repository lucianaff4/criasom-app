<?php
declare(strict_types=1);
require_once __DIR__.'/../src/PlatformBackend.php';
require_once __DIR__.'/../src/HttpKernel.php';
use Criasom\HttpRequest;
$checks=0;
function globalsCheck(bool $ok,string $label):void {global $checks;if(!$ok)throw new RuntimeException($label);$checks++;}
$savedServer=$_SERVER;$savedCookies=$_COOKIE;
try{
    $_COOKIE=[];
    $_SERVER=['REQUEST_METHOD'=>'POST','REQUEST_URI'=>'/api/v1/auth/request-code','REMOTE_ADDR'=>'127.0.0.1','HTTPS'=>'on','HTTP_CONTENT_TYPE'=>'application/json','CONTENT_TYPE'=>'application/json','HTTP_X_CSRF_TOKEN'=>'synthetic-only'];
    $request=HttpRequest::fromGlobals();
    globalsCheck($request->header('content-type')==='application/json','SAPI content-type must appear only once');
    globalsCheck($request->header('x-csrf-token')==='synthetic-only'&&$request->https,'ordinary headers and HTTPS retained');
    $_SERVER['HTTP_CONTENT_TYPE']='text/plain';
    globalsCheck(HttpRequest::fromGlobals()->header('content-type')==='application/json','SAPI CONTENT_TYPE is authoritative');
    unset($_SERVER['CONTENT_TYPE']);
    globalsCheck(HttpRequest::fromGlobals()->header('content-type')==='text/plain','HTTP-only content-type still accepted');
    $_SERVER['HTTP_X_BAD']="bad\r\nInjected: bad";
    try{HttpRequest::fromGlobals();globalsCheck(false,'CRLF must be rejected');}catch(InvalidArgumentException){globalsCheck(true,'CRLF rejected');}
    echo json_encode(['suite'=>'http-globals','passed'=>$checks,'scope'=>'SAPI globals regression; synthetic header values only'],JSON_THROW_ON_ERROR).PHP_EOL;
}finally{$_SERVER=$savedServer;$_COOKIE=$savedCookies;}
