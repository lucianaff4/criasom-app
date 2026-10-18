<?php
declare(strict_types=1);
if(PHP_SAPI!=='cli')exit(1);
require_once __DIR__.'/Lab.php';
new Criasom\Dev\Lab(true);
echo json_encode(['initialized'=>true,'syntheticOnly'=>true,'realEmailSent'=>false,'realPurchase'=>false],JSON_THROW_ON_ERROR).PHP_EOL;
