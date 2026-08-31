<?php
namespace Autonoma\Sdk;
class AutonomaError extends \RuntimeException {
    public readonly string $errorCode;
    public readonly int $status;

    public function __construct(
        string $message,
        string $code,
        int $status,
    ) {
        parent::__construct($message);
        $this->errorCode = $code;
        $this->status = $status;
    }

    public static function invalidSignature(): self {
        return new self('Invalid HMAC signature', 'INVALID_SIGNATURE', 401);
    }
    public static function invalidBody(string $detail): self {
        return new self("Invalid request body: {$detail}", 'INVALID_BODY', 400);
    }
    public static function unknownAction(string $action): self {
        return new self("Unknown action: {$action}", 'UNKNOWN_ACTION', 400);
    }
    /** Thrown by up when the request names a scenario that is not registered. */
    public static function unknownEnvironment(string $name): self {
        return new self("Unknown environment: {$name}", 'UNKNOWN_ENVIRONMENT', 400);
    }
    /** @deprecated The SDK no longer gates on production; this is never returned. */
    public static function productionBlocked(): self {
        return new self('Environment factory is disabled', 'PRODUCTION_BLOCKED', 404);
    }
    public static function invalidTeardownToken(string $detail): self {
        return new self("Invalid teardown token: {$detail}", 'INVALID_TEARDOWN_TOKEN', 403);
    }
    public static function sameSecrets(): self {
        return new self(
            'sharedSecret and signingSecret must be different. The shared secret is known by Autonoma; the signing secret must be private.',
            'SAME_SECRETS',
            500,
        );
    }
}
