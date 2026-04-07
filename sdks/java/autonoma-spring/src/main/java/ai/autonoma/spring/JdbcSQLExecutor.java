package ai.autonoma.spring;

import ai.autonoma.sdk.types.SQLExecutor;

import javax.sql.DataSource;
import java.sql.*;
import java.util.*;
import java.util.function.Function;
import java.util.Locale;

/**
 * JDBC-based implementation of SQLExecutor.
 * Wraps a standard {@link DataSource} to execute raw SQL queries and manage transactions.
 *
 * <p>Usage:
 * <pre>{@code
 * DataSource dataSource = ...;
 * SQLExecutor executor = new JdbcSQLExecutor(dataSource);
 * }</pre>
 */
public class JdbcSQLExecutor implements SQLExecutor {

    private final DataSource dataSource;
    private final Connection txConnection;

    public JdbcSQLExecutor(DataSource dataSource) {
        this.dataSource = dataSource;
        this.txConnection = null;
    }

    private JdbcSQLExecutor(Connection txConnection) {
        this.dataSource = null;
        this.txConnection = txConnection;
    }

    @Override
    public List<Map<String, Object>> query(String sql, Object... params) {
        try {
            Connection conn = txConnection != null ? txConnection : dataSource.getConnection();
            try {
                return executeQuery(conn, sql, params);
            } finally {
                if (txConnection == null) conn.close();
            }
        } catch (SQLException e) {
            throw new RuntimeException("SQL query failed: " + e.getMessage(), e);
        }
    }

    @Override
    public <T> T transaction(Function<SQLExecutor, T> fn) {
        if (txConnection != null) {
            // Already in a transaction, just execute
            return fn.apply(this);
        }

        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);
            try {
                T result = fn.apply(new JdbcSQLExecutor(conn));
                conn.commit();
                return result;
            } catch (Exception e) {
                conn.rollback();
                throw e;
            } finally {
                conn.setAutoCommit(true);
            }
        } catch (SQLException e) {
            throw new RuntimeException("Transaction failed: " + e.getMessage(), e);
        }
    }

    private List<Map<String, Object>> executeQuery(Connection conn, String sql, Object... params) throws SQLException {
        String trimmed = sql.trim().toUpperCase(Locale.ROOT);
        boolean isSelect = trimmed.startsWith("SELECT") || trimmed.contains("RETURNING");

        try (PreparedStatement stmt = conn.prepareStatement(sql)) {
            for (int i = 0; i < params.length; i++) {
                stmt.setObject(i + 1, params[i]);
            }

            if (isSelect) {
                try (ResultSet rs = stmt.executeQuery()) {
                    return resultSetToList(rs);
                }
            } else {
                stmt.executeUpdate();
                return List.of();
            }
        }
    }

    private List<Map<String, Object>> resultSetToList(ResultSet rs) throws SQLException {
        ResultSetMetaData meta = rs.getMetaData();
        int colCount = meta.getColumnCount();
        List<Map<String, Object>> results = new ArrayList<>();

        while (rs.next()) {
            Map<String, Object> row = new LinkedHashMap<>();
            for (int i = 1; i <= colCount; i++) {
                String colName = meta.getColumnLabel(i);
                row.put(colName, rs.getObject(i));
            }
            results.add(row);
        }

        return results;
    }
}
