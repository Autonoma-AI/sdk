<?php

// Minimal stdlib socket server that runs the PHP SDK's v2 handler with a couple
// of scenarios. Used by run-suites.mjs to exercise the shared protocol/suites/*
// against a real PHP endpoint. It mirrors protocol/servers/ruby-server.rb and
// go-server.go, calling Autonoma\Sdk\Handler::handleRequest directly.
//
// It requires the SDK src files directly via a tiny PSR-4 autoloader so it needs
// no composer build.

spl_autoload_register(function (string $class): void {
    $prefix = 'Autonoma\\Sdk\\';
    if (!str_starts_with($class, $prefix)) {
        return;
    }
    $relative = substr($class, strlen($prefix));
    $file = __DIR__ . '/../../sdks/php/src/' . str_replace('\\', '/', $relative) . '.php';
    if (is_file($file)) {
        require_once $file;
    }
});

use Autonoma\Sdk\Handler;
use Autonoma\Sdk\Refs;
use Autonoma\Sdk\Scenario;
use Autonoma\Sdk\Types\HandlerConfig;
use Autonoma\Sdk\Types\HandlerRequest;
use Autonoma\Sdk\Types\ScenarioDownContext;
use Autonoma\Sdk\Types\ScenarioUpContext;
use Autonoma\Sdk\Types\ScenarioUpResult;
use Autonoma\Sdk\Unique;

const REASON_PHRASES = [
    200 => 'OK',
    400 => 'Bad Request',
    401 => 'Unauthorized',
    403 => 'Forbidden',
    404 => 'Not Found',
    500 => 'Internal Server Error',
];

$sharedSecret = getenv('AUTONOMA_SHARED_SECRET') ?: 'protocol-shared';
$signingSecret = getenv('AUTONOMA_SIGNING_SECRET') ?: 'protocol-signing';
$port = (int) (getenv('PORT') ?: 4593);

$config = new HandlerConfig(
    sharedSecret: $sharedSecret,
    signingSecret: $signingSecret,
    sdk: ['orm' => 'none', 'server' => 'socket'],
    scenarios: [
        Scenario::defineScenario(
            name: 'standard',
            description: 'A standard seeded environment',
            up: fn(ScenarioUpContext $ctx): ScenarioUpResult => new ScenarioUpResult(
                auth: ['headers' => ['Authorization' => 'Bearer token-' . $ctx->testRunId]],
                teardown: ['userId' => 'user-' . $ctx->testRunId],
            ),
            down: fn(ScenarioDownContext $ctx) => null,
        ),
        Scenario::defineScenario(
            name: 'empty',
            description: 'Nothing seeded',
            up: fn(ScenarioUpContext $ctx): ScenarioUpResult => new ScenarioUpResult(),
        ),
    ],
);

$server = @stream_socket_server("tcp://127.0.0.1:{$port}", $errno, $errstr);
if ($server === false) {
    fwrite(STDERR, "php-server failed to bind on {$port}: {$errstr} ({$errno})\n");
    exit(1);
}

echo "php-server listening on {$port}\n";

/**
 * Read a full HTTP request off the connection: request line, headers, and a body
 * of Content-Length bytes. Returns [headers, body] or null on a dead connection.
 *
 * @return array{0: array<string, string>, 1: string}|null
 */
function read_request($conn): ?array
{
    $requestLine = fgets($conn);
    if ($requestLine === false) {
        return null;
    }

    $headers = [];
    while (($line = fgets($conn)) !== false) {
        if ($line === "\r\n" || $line === "\n") {
            break;
        }
        $pos = strpos($line, ':');
        if ($pos !== false) {
            $key = strtolower(trim(substr($line, 0, $pos)));
            $headers[$key] = trim(substr($line, $pos + 1));
        }
    }

    $length = (int) ($headers['content-length'] ?? 0);
    $body = '';
    while ($length > 0 && !feof($conn)) {
        $chunk = fread($conn, $length);
        if ($chunk === false || $chunk === '') {
            break;
        }
        $body .= $chunk;
        $length -= strlen($chunk);
    }

    return [$headers, $body];
}

function write_response($conn, int $status, string $bodyJson): void
{
    $reason = REASON_PHRASES[$status] ?? 'OK';
    $out = "HTTP/1.1 {$status} {$reason}\r\n";
    $out .= "Content-Type: application/json\r\n";
    $out .= 'Content-Length: ' . strlen($bodyJson) . "\r\n";
    $out .= "Connection: close\r\n\r\n";
    $out .= $bodyJson;
    fwrite($conn, $out);
}

while ($conn = @stream_socket_accept($server, -1)) {
    try {
        $parsed = read_request($conn);
        if ($parsed === null) {
            continue; // finally closes the connection
        }

        [$headers, $body] = $parsed;
        $req = new HandlerRequest(body: $body, headers: $headers);
        $res = Handler::handleRequest($config, $req);
        $json = json_encode(Refs::serializeForJson($res->body), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        write_response($conn, $res->status, $json === false ? '{}' : $json);
    } catch (\Throwable $e) {
        fwrite(STDERR, 'php-server error: ' . $e->getMessage() . "\n");
        write_response($conn, 500, json_encode(['error' => $e->getMessage(), 'code' => 'INTERNAL_ERROR']));
    } finally {
        fclose($conn);
    }
}
