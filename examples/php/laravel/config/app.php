<?php

return [
    'name' => 'Autonoma Example',
    'env' => env('APP_ENV', 'local'),
    'debug' => true,
    'key' => env('APP_KEY', 'base64:dGVzdC1rZXktZm9yLWV4YW1wbGUtb25seQ=='),
    'providers' => [
        // The Autonoma ServiceProvider is auto-discovered via composer.json extra
    ],
];
