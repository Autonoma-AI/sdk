package ai.autonoma.sdk;

/**
 * Database dialect abstraction — generates dialect-specific SQL strings.
 */
public interface Dialect {

    String name();

    /** Parameter placeholder for index (1-based). Postgres: $1, MySQL: ? */
    String param(int index);

    /** Quote an identifier. Postgres: "name", MySQL: `name` */
    String quoteId(String name);

    /** Whether INSERT ... RETURNING is supported */
    boolean supportsReturning();

    String tablesSQL(String schema);
    String columnsSQL(String schema);
    String primaryKeysSQL(String schema);
    String foreignKeysSQL(String schema);
    String enumsSQL(String schema);

    static Dialect get(String name) {
        if (name == null) name = "postgres";
        return switch (name) {
            case "postgres" -> new PostgresDialect();
            case "mysql" -> new MysqlDialect();
            default -> throw new RuntimeException("Dialect \"" + name + "\" is not yet supported. Currently only \"postgres\" and \"mysql\" are available.");
        };
    }
}
