<?php

namespace Autonoma\Sdk\Types;

/**
 * Configures the Autonoma request handler (Scenario v2). A host registers named
 * scenarios; the SDK owns the envelope (teardown-token signing, expiry defaults,
 * and the protocol version field).
 */
class HandlerConfig
{
    public function __construct(
        /** Shared secret - known by both you and Autonoma. Verifies HMAC signatures. */
        public readonly string $sharedSecret,
        /** Private signing secret - only you know this. Signs the teardown token. */
        public readonly string $signingSecret,
        /** @var ScenarioDefinition[] Every scenario the platform can run must be listed. */
        public readonly array $scenarios = [],
        /**
         * Token/environment lifetime returned on up as expiresInSeconds. Defaults
         * to one hour (3600) when null.
         */
        public readonly ?int $expiresInSeconds = null,
        /**
         * @deprecated Ignored; the endpoint is always enabled and HMAC signing is the gate.
         * On Autonoma previews (AUTONOMA_PREVIEWKIT set) no guard is needed; gate manually
         * in your handler for your own production deployments.
         */
        public readonly bool $allowProduction = false,
        /** @var array<string, string>|null SDK identity metadata; server adapters populate this. */
        public /*readonly*/ ?array $sdk = null,
    ) {
        if ($allowProduction) {
            trigger_error(
                'allowProduction is deprecated and ignored - the endpoint is always enabled',
                E_USER_DEPRECATED,
            );
        }
    }
}
