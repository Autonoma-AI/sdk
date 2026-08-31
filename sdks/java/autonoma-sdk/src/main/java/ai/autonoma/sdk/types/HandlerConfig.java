package ai.autonoma.sdk.types;

import java.util.List;

/**
 * Configuration for the Autonoma request handler (Scenario v2).
 *
 * <p>A host app registers named {@link ScenarioDefinition scenarios}; the
 * platform calls discover/up/down and the SDK owns the envelope: teardown-token
 * signing, expiry defaults, the data size/depth limits, and the protocol
 * version field. There is no factory-driven create graph.
 */
public class HandlerConfig {

    private final String sharedSecret;
    private final String signingSecret;
    private List<ScenarioDefinition> scenarios = List.of();
    private Integer expiresInSeconds;
    private boolean allowProduction = false;
    private SdkInfo sdk;

    public HandlerConfig(String sharedSecret, String signingSecret) {
        this.sharedSecret = sharedSecret;
        this.signingSecret = signingSecret;
    }

    public HandlerConfig(String sharedSecret, String signingSecret, List<ScenarioDefinition> scenarios) {
        this(sharedSecret, signingSecret);
        if (scenarios != null) this.scenarios = scenarios;
    }

    /** Shared secret - known by both you and Autonoma; it verifies HMAC signatures. */
    public String getSharedSecret() { return sharedSecret; }

    /** Private signing secret - only you know this; it signs the teardown token. */
    public String getSigningSecret() { return signingSecret; }

    /** Every scenario the platform can run. Never null. */
    public List<ScenarioDefinition> getScenarios() { return scenarios; }

    /**
     * Token/environment lifetime returned on up as {@code expiresInSeconds}.
     * When null the handler defaults to one hour (3600s).
     */
    public Integer getExpiresInSeconds() { return expiresInSeconds; }

    /**
     * @deprecated Ignored; the endpoint is always enabled and HMAC signing is
     * the gate. On Autonoma previews ({@code AUTONOMA_PREVIEWKIT} set) no guard
     * is needed; gate manually in your handler for your own production
     * deployments.
     */
    @Deprecated
    public boolean isAllowProduction() { return allowProduction; }

    public SdkInfo getSdk() { return sdk; }

    public HandlerConfig setScenarios(List<ScenarioDefinition> scenarios) {
        this.scenarios = scenarios != null ? scenarios : List.of();
        return this;
    }

    public HandlerConfig setExpiresInSeconds(Integer expiresInSeconds) {
        this.expiresInSeconds = expiresInSeconds;
        return this;
    }

    /**
     * @deprecated Ignored; the endpoint is always enabled and HMAC signing is
     * the gate. See {@link #isAllowProduction()}.
     */
    @Deprecated
    public HandlerConfig setAllowProduction(boolean allowProduction) {
        this.allowProduction = allowProduction;
        return this;
    }

    public HandlerConfig setSdk(SdkInfo sdk) {
        this.sdk = sdk;
        return this;
    }

    /** Create a copy with a different SdkInfo (used by server adapters to enrich metadata). */
    public HandlerConfig withSdk(SdkInfo sdk) {
        HandlerConfig copy = new HandlerConfig(sharedSecret, signingSecret, scenarios);
        copy.expiresInSeconds = this.expiresInSeconds;
        copy.allowProduction = this.allowProduction;
        copy.sdk = sdk;
        return copy;
    }
}
