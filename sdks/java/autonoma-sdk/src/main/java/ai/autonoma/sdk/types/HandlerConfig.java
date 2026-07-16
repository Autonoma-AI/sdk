package ai.autonoma.sdk.types;

import java.util.Map;
import java.util.function.BiFunction;
import java.util.function.Consumer;

/**
 * Configuration for the Autonoma request handler.
 *
 * <p>Factory-driven design: every model the dashboard can create must have
 * a registered factory. There is no SQL introspection or executor.
 */
public class HandlerConfig {

    private final String scopeField;
    private final String sharedSecret;
    private final String signingSecret;
    private final BiFunction<Map<String, Object>, AuthContext, AuthResult> auth;
    private Map<String, FactoryDefinition> factories;
    /** Deprecated - ignored; see {@link #setAllowProduction(boolean)}. */
    private boolean allowProduction = false;
    private SdkInfo sdk;
    private Consumer<HookContext> beforeDown;
    private BiFunction<HookContext, AuthResult, AuthResult> afterUp;

    public HandlerConfig(String scopeField, String sharedSecret, String signingSecret,
                         BiFunction<Map<String, Object>, AuthContext, AuthResult> auth) {
        this.scopeField = scopeField;
        this.sharedSecret = sharedSecret;
        this.signingSecret = signingSecret;
        this.auth = auth;
    }

    public String getScopeField() { return scopeField; }
    public String getSharedSecret() { return sharedSecret; }
    public String getSigningSecret() { return signingSecret; }
    /**
     * @deprecated Ignored; the endpoint is always enabled and HMAC signing is
     * the gate. On Autonoma previews ({@code AUTONOMA_PREVIEWKIT} set) no guard
     * is needed; gate manually in your handler for your own production
     * deployments.
     */
    @Deprecated
    public boolean isAllowProduction() { return allowProduction; }
    public BiFunction<Map<String, Object>, AuthContext, AuthResult> getAuth() { return auth; }
    public SdkInfo getSdk() { return sdk; }
    public Map<String, FactoryDefinition> getFactories() { return factories; }
    public Consumer<HookContext> getBeforeDown() { return beforeDown; }
    public BiFunction<HookContext, AuthResult, AuthResult> getAfterUp() { return afterUp; }

    /**
     * @deprecated Ignored; the endpoint is always enabled and HMAC signing is
     * the gate. On Autonoma previews ({@code AUTONOMA_PREVIEWKIT} set) no guard
     * is needed; gate manually in your handler for your own production
     * deployments.
     */
    @Deprecated
    public HandlerConfig setAllowProduction(boolean allowProduction) { this.allowProduction = allowProduction; return this; }
    public HandlerConfig setSdk(SdkInfo sdk) { this.sdk = sdk; return this; }
    public HandlerConfig setFactories(Map<String, FactoryDefinition> factories) { this.factories = factories; return this; }
    public HandlerConfig setBeforeDown(Consumer<HookContext> beforeDown) { this.beforeDown = beforeDown; return this; }
    public HandlerConfig setAfterUp(BiFunction<HookContext, AuthResult, AuthResult> afterUp) { this.afterUp = afterUp; return this; }

    /** Create a copy with a different SdkInfo (used by server adapters to enrich metadata). */
    public HandlerConfig withSdk(SdkInfo sdk) {
        HandlerConfig copy = new HandlerConfig(scopeField, sharedSecret, signingSecret, auth);
        copy.allowProduction = this.allowProduction;
        copy.sdk = sdk;
        copy.factories = this.factories;
        copy.beforeDown = this.beforeDown;
        copy.afterUp = this.afterUp;
        return copy;
    }
}
