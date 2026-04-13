<?php

namespace Autonoma\Sdk\Laravel;

use Autonoma\Sdk\Handler;
use Autonoma\Sdk\Refs;
use Autonoma\Sdk\Types\HandlerConfig;
use Autonoma\Sdk\Types\HandlerRequest;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class AutonomaController
{
    public function __invoke(Request $request, HandlerConfig $config): JsonResponse
    {
        return self::handle($request, $config);
    }

    public static function handle(Request $request, HandlerConfig $config): JsonResponse
    {
        // Enrich SDK metadata
        $config->sdk = array_merge($config->sdk ?? [], ['server' => 'laravel']);

        $handlerRequest = new HandlerRequest(
            body: $request->getContent(),
            headers: self::normalizeHeaders($request),
        );

        $response = Handler::handleRequest($config, $handlerRequest);

        return new JsonResponse(Refs::serializeForJson($response->body), $response->status);
    }

    private static function normalizeHeaders(Request $request): array
    {
        $headers = [];
        foreach ($request->headers->all() as $key => $values) {
            // Laravel returns header values as arrays; take the first value
            $headers[strtolower($key)] = is_array($values) ? ($values[0] ?? '') : $values;
        }
        return $headers;
    }
}
