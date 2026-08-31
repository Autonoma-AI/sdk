<?php

namespace Autonoma\Sdk\Types;

/**
 * What a scenario's up returns. Every field is optional; a scenario's up may
 * also return a plain associative array with 'auth' / 'teardown' keys.
 */
final class ScenarioUpResult
{
    public function __construct(
        /** @var array<string, mixed>|null Credentials the test runner uses to act as the seeded user. */
        public readonly ?array $auth = null,
        /**
         * @var array<string, mixed>|null Opaque handles carried inside the signed
         * teardown token and handed back to down verbatim.
         */
        public readonly ?array $teardown = null,
    ) {}
}
