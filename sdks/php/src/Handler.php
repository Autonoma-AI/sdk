<?php

namespace Autonoma\Sdk;

use Autonoma\Sdk\Types\FactoryContext;
use Autonoma\Sdk\Types\HandlerConfig;
use Autonoma\Sdk\Types\HandlerRequest;
use Autonoma\Sdk\Types\HandlerResponse;

/**
 * Request routing for discover/up/down protocol actions.
 *
 * Factory-driven design: every model in body.create must have a registered
 * factory. The SDK uses the factory's inputFields both to validate inputs
 * and to build the discover schema. Ordering for up and down comes from the
 * create payload's _alias/_ref graph; there is no SQL introspection.
 */
class Handler
{
    private const PROTOCOL_VERSION_HARDCODED = '1.0';
    public static string $PROTOCOL_VERSION = '';

    public static function getProtocolVersion(): string
    {
        if (self::$PROTOCOL_VERSION === '') {
            $path = __DIR__ . '/../../../../protocol/version.txt';
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
            if ($config->sharedSecret === $config->signingSecret) {
                throw AutonomaError::sameSecrets();
            }

            if (!$config->allowProduction) {
                $env = getenv('APP_ENV') ?: getenv('ENV') ?: '';
                if ($env === 'production') {
                    throw AutonomaError::productionBlocked();
                }
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
            if ($action === null) {
                throw AutonomaError::invalidBody('missing action. expected one of \'discover\', \'up\' or \'down\'');
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
        $schema = Schema::buildSchemaFromFactories($config->factories, $config->scopeField);
        return new HandlerResponse(
            status: 200,
            body: array_merge(self::buildSdkMeta($config), ['schema' => Schema::schemaToWire($schema)]),
        );
    }

    // -----------------------------------------------------------------------
    // up
    // -----------------------------------------------------------------------

    private static function handleUp(HandlerConfig $config, array $body): HandlerResponse
    {
        $create = $body['create'] ?? null;
        if ($create === null) {
            throw AutonomaError::invalidBody('missing "create" in request body');
        }

        $testRunId = $body['testRunId'] ?? self::generateUuid();

        $factories = $config->factories;
        if (empty($factories)) {
            throw AutonomaError::invalidBody(
                'no factories registered -- every model in `create` must have a factory.'
            );
        }

        $tree = PayloadTopo::resolvePayloadTree($create);

        $refs = [];
        $idMap = [];

        // Track per-model run index for {{index}} / {{cycle()}} substitution.
        $modelIndex = [];

        foreach ($tree->ops as $op) {
            $model = $op->model;
            $factory = $factories[$model] ?? null;
            if ($factory === null) {
                throw AutonomaError::invalidBody(
                    "no factory registered for model \"{$model}\". " .
                    "Register one with Factory::define(...) and add it to HandlerConfig factories."
                );
            }

            $idx = $modelIndex[$model] ?? 0;
            $modelIndex[$model] = $idx + 1;

            // Substitute built-in tokens then swap temp ids for real ids.
            $resolved = self::resolveTokens($op->fields, $testRunId, $idx);
            $resolved = self::swapTempIds($resolved, $idMap);

            // Validate through the factory's inputFields and call create.
            $validated = self::validateInput($resolved, $factory->inputFields);

            $ctx = new FactoryContext(
                refs: $refs,
                scenarioName: $testRunId,
                testRunId: $testRunId,
            );
            $record = ($factory->create)($validated, $ctx);

            if (!is_array($record) || !isset($record['id']) || $record['id'] === null) {
                throw AutonomaError::factoryMissingPk($model, 'id');
            }

            if (!isset($refs[$model])) {
                $refs[$model] = [];
            }
            $refs[$model][] = $record;
            $idMap[$op->tempId] = $record['id'];
        }

        // Auth callback gets the first User (case-insensitive on model name).
        $authUser = self::findFirstUser($refs);
        $scopeValue = self::detectScopeValue($refs, $config->scopeField) ?? $testRunId;
        $authContext = ['scope_value' => $scopeValue, 'refs' => $refs];
        $auth = ($config->auth)($authUser, $authContext);

        if ($config->afterUp !== null) {
            $hookCtx = ['scenarioName' => $scopeValue, 'refs' => $refs];
            $auth = ($config->afterUp)($hookCtx, $auth);
        }

        $refsToken = Refs::signRefs(
            [
                'refs' => $refs,
                'testRunId' => $scopeValue,
                'environment' => '',
                'aliasDependencies' => $tree->aliasDependencies,
                'aliasOwnerModel' => $tree->aliasOwnerModel,
            ],
            $config->signingSecret,
        );

        return new HandlerResponse(
            status: 200,
            body: array_merge(self::buildSdkMeta($config), [
                'auth' => $auth,
                'refs' => $refs,
                'refsToken' => $refsToken,
            ]),
        );
    }

    /**
     * Replace any __temp_* placeholder string with its real id.
     */
    private static function swapTempIds(mixed $value, array $idMap): mixed
    {
        if (is_string($value) && str_starts_with($value, '__temp_')) {
            return $idMap[$value] ?? $value;
        }
        if (is_array($value)) {
            $result = [];
            foreach ($value as $k => $v) {
                $result[$k] = self::swapTempIds($v, $idMap);
            }
            return $result;
        }
        return $value;
    }

    /**
     * Validate input against factory's inputFields.
     * Strips unknown keys and checks required fields are present.
     *
     * @param array<string, mixed> $data
     * @param \Autonoma\Sdk\Types\FieldInfo[] $inputFields
     * @return array<string, mixed>
     */
    private static function validateInput(array $data, array $inputFields): array
    {
        $knownFields = [];
        foreach ($inputFields as $field) {
            $knownFields[$field->name] = $field;
        }

        // Strip unknown keys.
        $validated = [];
        foreach ($data as $key => $value) {
            if (isset($knownFields[$key])) {
                $validated[$key] = $value;
            }
        }

        // Check required fields.
        foreach ($inputFields as $field) {
            if ($field->isRequired && !$field->hasDefault && !array_key_exists($field->name, $validated)) {
                throw AutonomaError::invalidBody("missing required field \"{$field->name}\"");
            }
        }

        return $validated;
    }

    // -----------------------------------------------------------------------
    // down
    // -----------------------------------------------------------------------

    private static function handleDown(HandlerConfig $config, array $body): HandlerResponse
    {
        $refsToken = $body['refsToken'] ?? null;
        if ($refsToken === null) {
            throw AutonomaError::invalidBody('missing refsToken');
        }

        try {
            $payload = Refs::verifyRefs($refsToken, $config->signingSecret);
        } catch (\Throwable $e) {
            throw AutonomaError::invalidRefsToken($e->getMessage());
        }

        $refs = $payload['refs'] ?? [];
        $testRunId = $payload['testRunId'] ?? '';
        $aliasDeps = $payload['aliasDependencies'] ?? [];
        $aliasOwnerModel = $payload['aliasOwnerModel'] ?? [];

        if ($config->beforeDown !== null) {
            $hookCtx = ['scenarioName' => $testRunId, 'refs' => $refs];
            ($config->beforeDown)($hookCtx);
        }

        $factories = $config->factories;
        $teardownOrder = PayloadTopo::computeTeardownOrder($refs, $aliasDeps, $aliasOwnerModel);

        foreach ($teardownOrder as $model) {
            $factory = $factories[$model] ?? null;
            if ($factory === null || $factory->teardown === null) {
                // No teardown means the host has decided not to delete this
                // model; skip. The SDK has no SQL fallback.
                continue;
            }
            $records = $refs[$model] ?? [];
            $ctx = new FactoryContext(
                refs: $refs,
                scenarioName: $testRunId,
                testRunId: $testRunId,
            );
            foreach (array_reverse($records) as $record) {
                ($factory->teardown)($record, $ctx);
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

    /**
     * Substitute built-in tokens in field values: {{testRunId}}, {{index}},
     * {{cycle(a,b,c)}}. Raises AutonomaError(UNRESOLVED_TOKEN) for any other
     * {{token}}.
     */
    public static function resolveTokens(mixed $value, string $testRunId, int $index): mixed
    {
        if (is_string($value)) {
            return preg_replace_callback(
                '/\{\{\s*([^{}]+?)\s*\}\}/',
                function (array $m) use ($testRunId, $index): string {
                    $token = trim($m[1]);
                    if ($token === 'testRunId') {
                        return $testRunId;
                    }
                    if ($token === 'index') {
                        return (string) $index;
                    }
                    if (preg_match('/^cycle\((.*)\)$/', $token, $cm) === 1) {
                        $parts = array_map(
                            fn(string $p): string => trim(trim(trim($p), '"'), "'"),
                            explode(',', $cm[1])
                        );
                        if (count($parts) === 0) {
                            return '';
                        }
                        return $parts[$index % count($parts)];
                    }
                    throw new AutonomaError(
                        "Unresolved token: {{{$token}}}",
                        'UNRESOLVED_TOKEN',
                        400
                    );
                },
                $value
            );
        }
        if (is_array($value)) {
            $out = [];
            foreach ($value as $k => $v) {
                $out[$k] = self::resolveTokens($v, $testRunId, $index);
            }
            return $out;
        }
        return $value;
    }

    private static function findFirstUser(array $refs): ?array
    {
        foreach ($refs as $model => $records) {
            $normalized = strtolower($model);
            if (($normalized === 'user' || $normalized === 'users') && !empty($records)) {
                return $records[0];
            }
        }
        return null;
    }

    private static function detectScopeValue(array $refs, string $scopeField): ?string
    {
        $scopeNormalized = strtolower(str_replace('_', '', $scopeField));
        foreach ($refs as $records) {
            foreach ($records as $record) {
                foreach ($record as $key => $value) {
                    if (strtolower(str_replace('_', '', $key)) === $scopeNormalized && is_string($value)) {
                        return $value;
                    }
                }
            }
        }
        return null;
    }

    private static function generateUuid(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
