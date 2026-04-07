package ai.autonoma.sdk;

public class PostgresDialect implements Dialect {

    @Override public String name() { return "postgres"; }
    @Override public String param(int index) { return "$" + index; }
    @Override public String quoteId(String name) { return "\"" + name + "\""; }
    @Override public boolean supportsReturning() { return true; }

    @Override
    public String tablesSQL(String schema) {
        return SqlQueries.POSTGRES_TABLES.replace("{{schema}}", schema);
    }

    @Override
    public String columnsSQL(String schema) {
        return SqlQueries.POSTGRES_COLUMNS.replace("{{schema}}", schema);
    }

    @Override
    public String primaryKeysSQL(String schema) {
        return SqlQueries.POSTGRES_PRIMARY_KEYS.replace("{{schema}}", schema);
    }

    @Override
    public String foreignKeysSQL(String schema) {
        return SqlQueries.POSTGRES_FOREIGN_KEYS.replace("{{schema}}", schema);
    }

    @Override
    public String enumsSQL(String schema) {
        return SqlQueries.POSTGRES_ENUMS;
    }
}
