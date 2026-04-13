<?php

return [
    'default' => 'pgsql',
    'connections' => [
        'pgsql' => [
            'driver' => 'pgsql',
            'host' => env('DB_HOST', 'localhost'),
            'port' => env('DB_PORT', '5432'),
            'database' => env('DB_DATABASE', 'autonoma_example'),
            'username' => env('DB_USERNAME', 'autonoma'),
            'password' => env('DB_PASSWORD', 'autonoma'),
        ],
    ],
    'migrations' => 'migrations',
];
