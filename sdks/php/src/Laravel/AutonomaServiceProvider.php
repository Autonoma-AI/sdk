<?php

namespace Autonoma\Sdk\Laravel;

use Autonoma\Sdk\Types\HandlerConfig;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\ServiceProvider;

class AutonomaServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->mergeConfigFrom(__DIR__ . '/config.php', 'autonoma');

        $this->app->singleton(HandlerConfig::class, function ($app) {
            $config = $app['config']['autonoma'];

            return new HandlerConfig(
                scopeField: $config['scope_field'],
                sharedSecret: $config['shared_secret'],
                signingSecret: $config['signing_secret'],
                auth: $config['auth'] ?? throw new \RuntimeException('Autonoma SDK requires an "auth" callback in config/autonoma.php'),
                factories: $config['factories'] ?? [],
                allowProduction: $config['allow_production'] ?? false,
                sdk: ['orm' => 'eloquent'],
            );
        });
    }

    public function boot(): void
    {
        $this->publishes([
            __DIR__ . '/config.php' => config_path('autonoma.php'),
        ], 'autonoma-config');

        $this->registerRoutes();
    }

    protected function registerRoutes(): void
    {
        $config = $this->app['config']['autonoma'] ?? [];
        $path = $config['path'] ?? 'api/autonoma';
        $middleware = $config['middleware'] ?? [];

        Route::post($path, function () {
            $config = app(HandlerConfig::class);
            return AutonomaController::handle(request(), $config);
        })->middleware($middleware);
    }
}
