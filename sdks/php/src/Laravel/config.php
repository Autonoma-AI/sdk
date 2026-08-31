<?php

return [
    /*
    |--------------------------------------------------------------------------
    | Autonoma SDK Configuration (Scenario v2)
    |--------------------------------------------------------------------------
    */

    // Shared secret (known by both Autonoma and your SDK).
    'shared_secret' => env('AUTONOMA_SHARED_SECRET', ''),

    // Signing secret (only known by your SDK -- never share with Autonoma).
    'signing_secret' => env('AUTONOMA_SIGNING_SECRET', ''),

    // Token/environment lifetime returned on up as expiresInSeconds. Defaults to
    // one hour (3600) when null.
    'expires_in_seconds' => env('AUTONOMA_EXPIRES_IN_SECONDS', null),

    // Deprecated - ignored; the endpoint is always enabled and HMAC signing is
    // the gate. On Autonoma previews (AUTONOMA_PREVIEWKIT set) no guard is
    // needed; gate manually in your handler for your own production deployments.
    'allow_production' => (bool) env('AUTONOMA_ALLOW_PRODUCTION', false),

    // Route path for the Autonoma endpoint.
    'path' => env('AUTONOMA_PATH', 'api/autonoma'),

    // Middleware to apply to the Autonoma route.
    'middleware' => [],

    // Scenarios: register one per named environment. Each scenario's up
    // provisions data and returns auth/teardown; the optional down tears it
    // back down. Build one with Scenario::defineScenario().
    //
    // 'scenarios' => [
    //     Scenario::defineScenario(
    //         name: 'single-user',
    //         description: 'One verified user in a fresh org',
    //         up: function (ScenarioUpContext $ctx): ScenarioUpResult {
    //             $email = Unique::uniqueEmail($ctx->testRunId);
    //             $user = User::create(['email' => $email]);
    //             return new ScenarioUpResult(
    //                 auth: ['headers' => ['Authorization' => "Bearer {$user->token}"]],
    //                 teardown: ['userId' => $user->id],
    //             );
    //         },
    //         down: fn(ScenarioDownContext $ctx) => User::destroy($ctx->teardown['userId']),
    //     ),
    // ],
    'scenarios' => [],
];
