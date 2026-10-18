<?php
declare(strict_types=1);
// Never use this router in a public server. public/index.php remains unchanged and closed.
require_once __DIR__.'/Lab.php';
use Criasom\Dev\Lab;
use Criasom\PlatformProblem;
try {
    $lab=new Lab();
    $request=$lab->trustedRequest();
    if(!$lab->streamAsset($request))$lab->handle($request)->emit();
} catch(PlatformProblem $error) {
    Lab::json($error->status,['error'=>$error->errorId])->emit();
} catch(Throwable $error) {
    // No error body/log contains cookies, keys, codes, email payloads, paths or SQL.
    Lab::json(503,['error'=>'laboratory_unavailable'])->emit();
}
return true;
