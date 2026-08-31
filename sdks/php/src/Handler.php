<?php

namespace Autonoma\Sdk;

use Autonoma\Sdk\Types\HandlerConfig;
use Autonoma\Sdk\Types\HandlerRequest;
use Autonoma\Sdk\Types\HandlerResponse;
use Autonoma\Sdk\Types\ScenarioDefinition;
use Autonoma\Sdk\Types\ScenarioDownContext;
use Autonoma\Sdk\Types\ScenarioUpContext;
use Autonoma\Sdk\Types\ScenarioUpResult;

/**
 * Request routing for discover / up / down protocol actions (Scenario v2).
 *
 * discover lists the registered scenarios; up looks a scenario up by name, runs
 * its free-form up, signs a teardown token carrying the scenario name, and
 * responds; down recovers the scenario name from the verified token and routes
 * to that scenario's down. There is no create-graph interpreter and no
 * factory-derived discover schema.
 */
class Handler
{
    private const PROTOCOL_VERSION_HARDCODED = '2.0';
    private const DEFAULT_EXPIRES_IN_SECONDS = 3600;

    public static string $PROTOCOL_VERSION = '';

    private static bool $warnedDeprecatedAllowProduction = false;

    public static function getProtocolVersion(): string
    {
        if (self::$PROTOCOL_VERSION === '') {
            $path = __DIR__ . '/../../../protocol/version.txt';
            if (is_file($path)) {
                self::$PROTOCOL_VERSION = trim(file_get_contents($path));
            } else {
                self::$PROTOCOL_VERSION = self::PROTOCOL_VERSION_HARDCODED;
            }
        }
        return self::$PROTOCOL_VERSION;
    }

    public static function handleRequest(HandlerConfig $config, HandlerRequest $req): HandlerResponse
    {
        try {
            if ($config->allowProduction && !self::$warnedDeprecatedAllowProduction) {
                self::$warnedDeprecatedAllowProduction = true;
                error_log('[autonoma] allowProduction is deprecated and ignored - the endpoint is always enabled');
            }

            if ($config->sharedSecret === $config->signingSecret) {
                throw AutonomaError::sameSecrets();
            }

            $signature = $req->headers['x-signature'] ?? $req->headers['X-Signature'] ?? '';
            if (!Hmac::verifySignature($req->body, $signature, $config->sharedSecret)) {
                throw AutonomaError::invalidSignature();
            }

            $body = json_decode($req->body, true);
            if (!is_array($body)) {
                throw AutonomaError::invalidBody('invalid JSON');
            }

            $action = $body['action'] ?? null;
            if (!is_string($action) || $action === '') {
                throw AutonomaError::invalidBody('missing action. expected one of "discover", "up" or "down"');
            }

            return match ($action) {
                'discover' => self::handleDiscover($config),
                'up' => self::handleUp($config, $body),
                'down' => self::handleDown($config, $body),
                default => throw AutonomaError::unknownAction($action),
            };
        } catch (AutonomaError $e) {
            return new HandlerResponse(status: $e->status, body: ['error' => $e->getMessage(), 'code' => $e->errorCode]);
        } catch (\Throwable $e) {
            return new HandlerResponse(status: 500, body: ['error' => $e->getMessage(), 'code' => 'INTERNAL_ERROR']);
        }
    }

    private static function buildSdkMeta(HandlerConfig $config): array
    {
        $sdk = $config->sdk ?? [];
        return [
            'version' => self::getProtocolVersion(),
            'sdk' => [
                'language' => 'php',
                'orm' => $sdk['orm'] ?? 'unknown',
                'server' => $sdk['server'] ?? 'unknown',
            ],
        ];
    }

    // -----------------------------------------------------------------------
    // discover
    // -----------------------------------------------------------------------

    private static function handleDiscover(HandlerConfig $config): HandlerResponse
    {
        $scenarios = [];
        foreach ($config->scenarios as $s) {
            $scenarios[] = ['name' => $s->name, 'description' => $s->description];
        }
        return new HandlerResponse(
            status: 200,
            body: array_merge(self::buildSdkMeta($config), ['scenarios' => $scenarios]),
        );
    }

    // -----------------------------------------------------------------------
    // up
    // -----------------------------------------------------------------------

    private static function handleUp(HandlerConfig $config, array $body): HandlerResponse
    {
        $name = self::readScenarioName($body);
        if ($name === null || $name === '') {
            throw AutonomaError::invalidBody('missing "scenario.name" in request body');
        }

        $scenario = self::findScenario($config, $name);
        if ($scenario === null) {
            throw AutonomaError::unknownEnvironment($name);
        }

        $rawTestRunId = $body['testRunId'] ?? null;
        $testRunId = (is_string($rawTestRunId) && $rawTestRunId !== '') ? $rawTestRunId : self::generateUuid();

        $result = ($scenario->up)(new ScenarioUpContext(testRunId: $testRunId));
        [$auth, $teardown] = self::readUpResult($result);

        $teardownToken = Refs::signRefs(
            [
                'refs' => $teardown ?? [],
                'testRunId' => $testRunId,
                'environment' => $name,
            ],
            $config->signingSecret,
        );

        $expiresInSeconds = $config->expiresInSeconds ?? self::DEFAULT_EXPIRES_IN_SECONDS;

        $responseBody = self::buildSdkMeta($config);
        if ($auth !== null) {
            $responseBody['auth'] = $auth;
        }
        $responseBody['teardownToken'] = $teardownToken;
        $responseBody['expiresInSeconds'] = $expiresInSeconds;

        return new HandlerResponse(status: 200, body: $responseBody);
    }

    // -----------------------------------------------------------------------
    // down
    // -----------------------------------------------------------------------

    private static function handleDown(HandlerConfig $config, array $body): HandlerResponse
    {
        $teardownToken = $body['teardownToken'] ?? null;
        if (!is_string($teardownToken) || $teardownToken === '') {
            throw AutonomaError::invalidBody('missing teardownToken');
        }

        try {
            $payload = Refs::verifyRefs($teardownToken, $config->signingSecret);
        } catch (\Throwable $e) {
            throw AutonomaError::invalidTeardownToken($e->getMessage());
        }

        $teardown = $payload['refs'] ?? [];
        if (!is_array($teardown)) {
            $teardown = [];
        }
        $testRunId = is_string($payload['testRunId'] ?? null) ? $payload['testRunId'] : '';
        // The verified token is authoritative for routing; any scenario name on
        // the request body is ignored.
        $name = is_string($payload['environment'] ?? null) ? $payload['environment'] : '';

        if ($name !== '') {
            $scenario = self::findScenario($config, $name);
            if ($scenario !== null && $scenario->down !== null) {
                ($scenario->down)(new ScenarioDownContext(
                    name: $name,
                    teardown: $teardown,
                    testRunId: $testRunId,
                ));
            }
        }

        return new HandlerResponse(
            status: 200,
            body: array_merge(self::buildSdkMeta($config), ['ok' => true]),
        );
    }

    // -----------------------------------------------------------------------
    // helpers
    // -----------------------------------------------------------------------

    private static function findScenario(HandlerConfig $config, string $name): ?ScenarioDefinition
    {
        foreach ($config->scenarios as $s) {
            if ($s->name === $name) {
                return $s;
            }
        }
        return null;
    }

    /** Read body.scenario.name from an untrusted JSON body. */
    private static function readScenarioName(array $body): ?string
    {
        $scenario = $body['scenario'] ?? null;
        if (!is_array($scenario)) {
            return null;
        }
        $sname = $scenario['name'] ?? null;
        return is_string($sname) ? $sname : null;
    }

    /**
     * Normalize a scenario up return into [auth, teardown]. Accepts a
     * ScenarioUpResult or a plain associative array with those keys.
     *
     * @return array{0: ?array, 1: ?array}
     */
    private static function readUpResult(mixed $result): array
    {
        if ($result instanceof ScenarioUpResult) {
            return [$result->auth, $result->teardown];
        }
        if (is_array($result)) {
            $auth = $result['auth'] ?? null;
            $teardown = $result['teardown'] ?? null;
            return [
                is_array($auth) ? $auth : null,
                is_array($teardown) ? $teardown : null,
            ];
        }
        return [null, null];
    }

    private static function generateUuid(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
