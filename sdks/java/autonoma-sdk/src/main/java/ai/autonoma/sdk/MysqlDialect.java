package ai.autonoma.sdk;

public class MysqlDialect implements Dialect {

    @Override public String name() { return "mysql"; }
    @Override public String param(int index) { return "?"; }
    @Override public String quoteId(String name) { return "`" + name + "`"; }
    @Override public boolean supportsReturning() { return false; }

    @Override
    public String tablesSQL(String schema) {
        return SqlQueries.MYSQL_TABLES.replace("{{schema}}", schema);
    }

    @Override
    public String columnsSQL(String schema) {
        return SqlQueries.MYSQL_COLUMNS.replace("{{schema}}", schema);
    }

    @Override
    public String primaryKeysSQL(String schema) {
        return SqlQueries.MYSQL_PRIMARY_KEYS.replace("{{schema}}", schema);
    }

    @Override
    public String foreignKeysSQL(String schema) {
        return SqlQueries.MYSQL_FOREIGN_KEYS.replace("{{schema}}", schema);
    }

    @Override
    public String enumsSQL(String schema) {
        return SqlQueries.MYSQL_ENUMS;
    }
}
