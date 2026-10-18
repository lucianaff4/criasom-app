<?php
declare(strict_types=1);
// Deliberate deployment interlock: this package is a local implementation candidate.
http_response_code(503);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
echo json_encode(['error'=>'preparation_only','message'=>'Serviço em preparação.'], JSON_UNESCAPED_UNICODE);
