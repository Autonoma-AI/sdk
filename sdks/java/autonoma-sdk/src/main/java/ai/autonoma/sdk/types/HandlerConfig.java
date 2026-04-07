package ai.autonoma.sdk.types;

import java.util.List;
import java.util.Map;
import java.util.function.Function;

public class HandlerConfig {

    private final SQLExecutor executor;
    private final String scopeField;
    private final String sharedSecret;
    private final String signingSecret;
    private String dialect = "postgres";
    private String dbSchema;
    private Map<String, String> tableNameMap;
    private List<String> excludeTables;
    private boolean allowProduction = false;
    private Function<Map<String, Object>, Map<String, Object>> auth;
    private SdkInfo sdk;

    public HandlerConfig(SQLExecutor executor, String scopeField, String sharedSecret, String signingSecret) {
        this.executor = executor;
        this.scopeField = scopeField;
        this.sharedSecret = sharedSecret;
        this.signingSecret = signingSecret;
    }

    public SQLExecutor getExecutor() { return executor; }
    public String getScopeField() { return scopeField; }
    public String getSharedSecret() { return sharedSecret; }
    public String getSigningSecret() { return signingSecret; }
    public String getDialect() { return dialect; }
    public String getDbSchema() { return dbSchema; }
    public Map<String, String> getTableNameMap() { return tableNameMap; }
    public List<String> getExcludeTables() { return excludeTables; }
    public boolean isAllowProduction() { return allowProduction; }
    public Function<Map<String, Object>, Map<String, Object>> getAuth() { return auth; }
    public SdkInfo getSdk() { return sdk; }

    public HandlerConfig setDialect(String dialect) { this.dialect = dialect; return this; }
    public HandlerConfig setDbSchema(String dbSchema) { this.dbSchema = dbSchema; return this; }
    public HandlerConfig setTableNameMap(Map<String, String> tableNameMap) { this.tableNameMap = tableNameMap; return this; }
    public HandlerConfig setExcludeTables(List<String> excludeTables) { this.excludeTables = excludeTables; return this; }
    public HandlerConfig setAllowProduction(boolean allowProduction) { this.allowProduction = allowProduction; return this; }
    public HandlerConfig setAuth(Function<Map<String, Object>, Map<String, Object>> auth) { this.auth = auth; return this; }
    public HandlerConfig setSdk(SdkInfo sdk) { this.sdk = sdk; return this; }

    /** Create a copy with a different SdkInfo (used by server adapters to enrich metadata). */
    public HandlerConfig withSdk(SdkInfo sdk) {
        HandlerConfig copy = new HandlerConfig(executor, scopeField, sharedSecret, signingSecret);
        copy.dialect = this.dialect;
        copy.dbSchema = this.dbSchema;
        copy.tableNameMap = this.tableNameMap;
        copy.excludeTables = this.excludeTables;
        copy.allowProduction = this.allowProduction;
        copy.auth = this.auth;
        copy.sdk = sdk;
        return copy;
    }
}
