<?php

// Use Composer autoloader if available, otherwise register a simple PSR-4 loader
$autoload = __DIR__ . '/../vendor/autoload.php';
if (file_exists($autoload)) {
    require_once $autoload;
} else {
    spl_autoload_register(function (string $class) {
        $prefix = 'Autonoma\\Sdk\\';
        if (!str_starts_with($class, $prefix)) return;
        $relative = substr($class, strlen($prefix));
        $file = __DIR__ . '/../src/' . str_replace('\\', '/', $relative) . '.php';
        if (file_exists($file)) require_once $file;
    });
}

use Autonoma\Sdk\Hmac;
use Autonoma\Sdk\Refs;

$data = json_decode(file_get_contents('php://stdin'), true);

try {
    $mod = $data['module'];
    $fn = $data['function'];
    $inp = $data['input'];

    // Scenario-v2 dropped the create-graph interpreter and fingerprint(); the PHP
    // bridge conforms only on the unchanged hmac + refs primitives. verifyRefs
    // returns the decoded { refs, testRunId, environment } payload.
    $result = match ("{$mod}.{$fn}") {
        'hmac.signBody' => Hmac::signBody($inp['body'], $inp['secret']),
        'hmac.verifySignature' => Hmac::verifySignature($inp['body'], $inp['signature'], $inp['secret']),
        'refs.signRefs' => Refs::signRefs($inp['payload'], $inp['secret']),
        'refs.verifyRefs' => Refs::verifyRefs($inp['token'], $inp['secret']),
        default => throw new \RuntimeException("Unknown dispatch: {$mod}.{$fn}"),
    };

    echo json_encode(['ok' => true, 'result' => $result], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n";
} catch (\Throwable $e) {
    echo json_encode(['ok' => false, 'error' => $e->getMessage()]) . "\n";
}
