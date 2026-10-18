<?php
declare(strict_types=1);

// NOT LOADED by config.example.php or the laboratory. No real Hotmart IDs.
// Before activation: verify exact product/offer IDs and courses in each offer.
// Example course scopes match the local pilot; they are not a complete Black catalog.
return [
    [
        'verified' => false,
        'product_id' => 'REPLACE_BLACK_PRODUCT',
        'offer_code' => 'REPLACE_BLACK_OFFER',
        'benefits' => [
            ['scopes' => ['course:penta', 'course:harmonia'], 'duration' => 'lifetime'],
            ['scopes' => ['app'], 'duration' => 'fixed_months', 'months' => 12, 'timezone' => 'America/Sao_Paulo'],
        ],
    ],
    [
        'verified' => false,
        'product_id' => 'REPLACE_APP_PRODUCT',
        'offer_code' => 'REPLACE_APP_ANNUAL_OFFER',
        'benefits' => [
            ['scopes' => ['app'], 'duration' => 'fixed_months', 'months' => 12, 'timezone' => 'America/Sao_Paulo'],
        ],
    ],
];
