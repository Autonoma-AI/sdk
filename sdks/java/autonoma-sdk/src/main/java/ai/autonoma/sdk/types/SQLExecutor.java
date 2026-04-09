package ai.autonoma.sdk.types;

import java.util.List;
import java.util.Map;
import java.util.function.Function;

/**
 * Minimal SQL executor — wrap your DB connection (JDBC DataSource, JPA EntityManager, etc.) into this.
 */
public interface SQLExecutor {

    /**
     * Execute a SQL query with parameterized values. Returns rows as plain maps.
     */
    List<Map<String, Object>> query(String sql, Object... params);

    /**
     * Execute a block within a transaction.
     * The callback receives an executor scoped to the transaction.
     * If the callback throws, the transaction is rolled back.
     */
    <T> T transaction(Function<SQLExecutor, T> fn);
}
