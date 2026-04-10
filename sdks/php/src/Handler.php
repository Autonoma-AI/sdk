<?php

namespace Autonoma\Sdk;

use Autonoma\Sdk\Dialect\DialectFactory;
use Autonoma\Sdk\Types\HandlerConfig;
use Autonoma\Sdk\Types\HandlerRequest;
use Autonoma\Sdk\Types\HandlerResponse;
use Autonoma\Sdk\Types\IntrospectionResult;

class Handler
{
    public static string $PROTOCOL_VERSION = '';

    public static function getProtocolVersion(): string
    {
        if (self::$PROTOCOL_VERSION === '') {
            self::$PROTOCOL_VERSION = trim(file_get_contents(__DIR__ . '/../../../../protocol/version.txt'));
        }
        return self::$PROTOCOL_VERSION;
    }

    /** @var array<int, IntrospectionResult> Cache introspection results per config */
    private static array $introspectionCache = [];

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
                throw AutonomaError::invalidBody('missing action');
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

    private static function getIntrospection(HandlerConfig $config): IntrospectionResult
    {
        $cacheKey = spl_object_id($config);
        if (isset(self::$introspectionCache[$cacheKey])) {
            return self::$introspectionCache[$cacheKey];
        }

        $dialect = DialectFactory::get($config->dialect);
        $result = Introspect::introspectDatabase(
            $config->executor,
            $dialect,
            $config->scopeField,
            $config->dbSchema,
            $config->tableNameMap,
            $config->excludeTables,
        );
        self::$introspectionCache[$cacheKey] = $result;
        return $result;
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

    private static function handleDiscover(HandlerConfig $config): HandlerResponse
    {
        $introspection = self::getIntrospection($config);
        $schema = $introspection->schema;

        $schemaDict = [
            'models' => array_map(fn($m) => [
                'name' => $m->name,
                'tableName' => $m->tableName,
                'fields' => array_map(fn($f) => [
                    'name' => $f->name,
                    'type' => $f->type,
                    'isRequired' => $f->isRequired,
                    'isId' => $f->isId,
                    'hasDefault' => $f->hasDefault,
                ], $m->fields),
            ], $schema->models),
            'edges' => array_map(fn($e) => [
                'from' => $e->fromModel,
                'to' => $e->toModel,
                'localField' => $e->localField,
                'foreignField' => $e->foreignField,
                'nullable' => $e->nullable,
            ], $schema->edges),
            'relations' => array_map(fn($r) => [
                'parentModel' => $r->parentModel,
                'childModel' => $r->childModel,
                'parentField' => $r->parentField,
                'childField' => $r->childField,
            ], $schema->relations),
            'scopeField' => $schema->scopeField,
        ];

        return new HandlerResponse(
            status: 200,
            body: array_merge(self::buildSdkMeta($config), ['schema' => $schemaDict]),
        );
    }

    private static function handleUp(HandlerConfig $config, array $body): HandlerResponse
    {
        $create = $body['create'] ?? null;
        if ($create === null) {
            throw AutonomaError::invalidBody('missing "create" in request body');
        }

        $testRunId = $body['testRunId'] ?? self::generateUuid();
        $introspection = self::getIntrospection($config);
        $schema = $introspection->schema;
        $dialect = DialectFactory::get($config->dialect);

        $tree = Tree::resolveTree($create, $schema);
        $refs = [];
        $idMap = [];

        $config->executor->transaction(function ($tx) use (
            &$refs, &$idMap, $tree, $schema, $dialect, $introspection, $config,
        ) {
            $i = 0;
            while ($i < count($tree->ops)) {
                $op = $tree->ops[$i];
                $model = $op->model;

                // Collect consecutive ops for same model with same batch flag
                $batch = [$op];
                while ($i + 1 < count($tree->ops) &&
                    $tree->ops[$i + 1]->model === $model &&
                    $tree->ops[$i + 1]->batch === $op->batch) {
                    $i++;
                    $batch[] = $tree->ops[$i];
                }

                // Find model info for auto-populating fields
                $modelInfo = null;
                foreach ($schema->models as $m) {
                    if ($m->name === $model) {
                        $modelInfo = $m;
                        break;
                    }
                }

                // Bug 4: find actual PK field name from schema
                $pkField = null;
                if ($modelInfo !== null) {
                    foreach ($modelInfo->fields as $f) {
                        if ($f->isId) {
                            $pkField = $f;
                            break;
                        }
                    }
                }
                $pkFieldName = $pkField !== null ? $pkField->name : 'id';

                $resolvedFields = [];
                foreach ($batch as $b) {
                    $fields = $b->fields;
                    unset($fields[$pkFieldName]);

                    // Replace temp IDs with real IDs
                    foreach ($fields as $key => &$value) {
                        if (is_string($value) && str_starts_with($value, '__temp_')) {
                            $realId = $idMap[$value] ?? null;
                            if ($realId !== null) {
                                $value = $realId;
                            }
                        }
                    }
                    unset($value);

                    // Inject scope field if applicable
                    $scopeEdge = null;
                    foreach ($schema->edges as $e) {
                        if ($e->fromModel === $model &&
                            strtolower($e->localField) === strtolower($schema->scopeField) &&
                            $e->fromModel !== $e->toModel) {
                            $scopeEdge = $e;
                            break;
                        }
                    }
                    if ($scopeEdge !== null && !isset($fields[$scopeEdge->localField])) {
                        $scopeVal = self::detectScopeValue($refs, $schema->scopeField);
                        if ($scopeVal !== null) {
                            $fields[$scopeEdge->localField] = $scopeVal;
                        }
                    }

                    // Auto-populate required DateTime fields without defaults
                    if ($modelInfo !== null) {
                        foreach ($modelInfo->fields as $field) {
                            if ($field->isRequired && !$field->hasDefault && !$field->isId && !isset($fields[$field->name])) {
                                if ($field->type === 'DateTime') {
                                    $fields[$field->name] = new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
                                }
                            }
                        }
                    }

                    $resolvedFields[] = $fields;
                }

                $spec = [$model => ['count' => count($resolvedFields), 'fields' => $resolvedFields, 'batch' => $op->batch]];
                $created = Create::createEntities($tx, $dialect, $introspection->tableMap, $introspection->columnMaps, $spec, $introspection->enumTypeMaps, $schema->models);
                $records = $created[$model] ?? [];

                if (!isset($refs[$model])) {
                    $refs[$model] = [];
                }
                $refs[$model] = array_merge($refs[$model], $records);

                foreach ($batch as $j => $b) {
                    if ($j < count($records)) {
                        $record = $records[$j];
                        $recordId = $record[$pkFieldName] ?? null;
                        if ($recordId !== null) {
                            $idMap[$b->tempId] = $recordId;
                        }
                    }
                }

                $i++;
            }

            // Resolve deferred FK updates
            foreach ($tree->deferredUpdates as $deferred) {
                $realTargetId = $idMap[$deferred->targetTempId] ?? null;
                $refTempId = $tree->aliases[$deferred->refAlias] ?? null;
                $realRefId = $refTempId !== null ? ($idMap[$refTempId] ?? null) : null;

                if ($realTargetId === null || $realRefId === null) {
                    throw new \RuntimeException(
                        "_ref \"{$deferred->refAlias}\" could not be resolved. " .
                        "Ensure the referenced node has _alias defined in the scenario."
                    );
                }

                // Find PK field name for the deferred model
                $deferredModelInfo = null;
                foreach ($schema->models as $m) {
                    if ($m->name === $deferred->model) {
                        $deferredModelInfo = $m;
                        break;
                    }
                }
                $deferredPkFieldName = 'id';
                if ($deferredModelInfo !== null) {
                    foreach ($deferredModelInfo->fields as $f) {
                        if ($f->isId) {
                            $deferredPkFieldName = $f->name;
                            break;
                        }
                    }
                }

                Create::updateEntity(
                    $tx, $dialect, $introspection->tableMap, $introspection->columnMaps,
                    $deferred->model, (string) $realTargetId, [$deferred->field => $realRefId],
                    $introspection->enumTypeMaps, $deferredPkFieldName,
                );
            }
        });

        $scopeValue = self::detectScopeValue($refs, $schema->scopeField) ?? $testRunId;

        $firstUser = self::findFirstUser($refs);
        $auth = ($config->auth)($firstUser);

        $refsToken = Refs::signRefs(
            ['refs' => $refs, 'testRunId' => $scopeValue, 'environment' => ''],
            $config->signingSecret,
        );

        return new HandlerResponse(
            status: 200,
            body: array_merge(self::buildSdkMeta($config), ['auth' => $auth, 'refs' => $refs, 'refsToken' => $refsToken]),
        );
    }

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

        $introspection = self::getIntrospection($config);
        $dialect = DialectFactory::get($config->dialect);

        Teardown::teardown(
            $config->executor,
            $dialect,
            $introspection->tableMap,
            $introspection->columnMaps,
            $introspection->schema,
            $payload['testRunId'],
            $payload['refs'] ?? null,
        );

        return new HandlerResponse(
            status: 200,
            body: array_merge(self::buildSdkMeta($config), ['ok' => true]),
        );
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
        $scopeLower = strtolower($scopeField);
        foreach ($refs as $records) {
            foreach ($records as $record) {
                foreach ($record as $key => $value) {
                    if (strtolower($key) === $scopeLower && is_string($value)) {
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
