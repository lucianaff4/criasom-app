<?php
return [
    'deployment_enabled' => false,
    'production_ready' => false,
    'base_url' => null, // Domain spelling/ownership must be confirmed first.
    'database_dsn' => null,
    'application_key' => null, // Private 32-byte key, outside the public document root.
    'hotmart_hottok' => null,
    'email_transport' => null,
    'media_provider' => null,
    'product_policies' => [], // No real offer grants any entitlement until its mapping is verified.
];
