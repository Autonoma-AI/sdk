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
        return new self('Invalid signature', 'INVALID_SIGNATURE', 401);
    }
    public static function invalidBody(string $detail): self {
        return new self("Invalid body: {$detail}", 'INVALID_BODY', 400);
    }
    public static function unknownAction(string $action): self {
        return new self("Unknown action: {$action}", 'UNKNOWN_ACTION', 400);
    }
    /** @deprecated The SDK no longer gates on production; this is never returned. */
    public static function productionBlocked(): self {
        return new self('Environment factory is disabled', 'PRODUCTION_BLOCKED', 404);
    }
    public static function invalidRefsToken(string $detail): self {
        return new self("Invalid refs token: {$detail}", 'INVALID_REFS_TOKEN', 403);
    }
    public static function sameSecrets(): self {
        return new self(
            'sharedSecret and signingSecret must be different. The shared secret is known by Autonoma; the signing secret must be private.',
            'SAME_SECRETS',
            500,
        );
    }
    public static function factoryMissingPk(string $model, string $pkField): self {
        return new self(
            "Factory for \"{$model}\" must return a record with \"{$pkField}\"",
            'FACTORY_MISSING_PK',
            500,
        );
    }
}
