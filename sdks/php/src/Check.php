<?php

namespace Autonoma\Sdk;

use Autonoma\Sdk\Types\HandlerConfig;
use Autonoma\Sdk\Types\HandlerRequest;

class Check
{
    /**
     * Run a full up→down cycle and return structured errors.
     */
    public static function checkScenario(
        $executor,
        array $scenario,
        array $options = [],
    ): CheckResult {
        $sharedSecret = $options['sharedSecret'] ?? 'autonoma-check-shared';
        $signingSecret = $options['signingSecret'] ?? 'autonoma-check-signing';

        $config = new HandlerConfig(
            executor: $executor,
            scopeField: $options['scopeField'] ?? 'organizationId',
            sharedSecret: $sharedSecret,
            signingSecret: $signingSecret,
            dialect: $options['dialect'] ?? 'postgres',
            dbSchema: $options['dbSchema'] ?? null,
            tableNameMap: $options['tableNameMap'] ?? null,
            auth: $options['auth'] ?? fn($u) => ['token' => 'check-token'],
        );

        // Up
        $upBody = json_encode(['action' => 'up', 'create' => $scenario['create'] ?? []], JSON_UNESCAPED_SLASHES);
        $upReq = new HandlerRequest(
            body: $upBody,
            headers: ['x-signature' => Hmac::signBody($upBody, $sharedSecret)],
        );

        $t0 = hrtime(true);
        $upRes = Handler::handleRequest($config, $upReq);
        $upMs = (int) ((hrtime(true) - $t0) / 1_000_000);

        if ($upRes->status !== 200) {
            $errorMsg = $upRes->body['error'] ?? 'Unknown error';
            return new CheckResult(
                valid: false,
                phase: 'up',
                errors: [new CheckError(phase: 'up', message: $errorMsg, fix: self::suggestFix($errorMsg))],
                timing: ['upMs' => $upMs, 'downMs' => 0],
            );
        }

        // Down
        $refsToken = $upRes->body['refsToken'] ?? '';
        $downBody = json_encode(['action' => 'down', 'refsToken' => $refsToken], JSON_UNESCAPED_SLASHES);
        $downReq = new HandlerRequest(
            body: $downBody,
            headers: ['x-signature' => Hmac::signBody($downBody, $sharedSecret)],
        );

        $t1 = hrtime(true);
        $downRes = Handler::handleRequest($config, $downReq);
        $downMs = (int) ((hrtime(true) - $t1) / 1_000_000);

        if ($downRes->status !== 200) {
            $errorMsg = $downRes->body['error'] ?? 'Unknown error';
            return new CheckResult(
                valid: false,
                phase: 'down',
                errors: [new CheckError(phase: 'down', message: $errorMsg)],
                timing: ['upMs' => $upMs, 'downMs' => $downMs],
            );
        }

        return new CheckResult(valid: true, phase: 'ok', errors: [], timing: ['upMs' => $upMs, 'downMs' => $downMs]);
    }

    private static function suggestFix(string $errorMsg): string
    {
        $lower = strtolower($errorMsg);
        if (str_contains($lower, 'unique constraint') || str_contains($errorMsg, 'Unique constraint failed')) {
            if (preg_match('/fields: \(`(.+?)`\)/', $errorMsg, $m) || preg_match('/constraint "(.+?)"/', $errorMsg, $m)) {
                return "Unique constraint on ({$m[1]}). Add {{testRunId}} or {{index}} to make values unique.";
            }
            return 'Unique constraint violation. Make field values unique across instances.';
        }
        if (str_contains($lower, 'foreign key')) {
            return 'A referenced record does not exist. Check that parent entities are nested correctly.';
        }
        if (str_contains($errorMsg, 'null value in column') || str_contains($errorMsg, 'must not be null')) {
            return 'A required field is null. Add it to the node with a value.';
        }
        return '';
    }
}
