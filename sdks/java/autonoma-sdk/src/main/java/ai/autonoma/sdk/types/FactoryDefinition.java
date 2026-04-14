package ai.autonoma.sdk.types;

import java.util.Map;

/**
 * A factory for creating entities via user code instead of raw SQL.
 * The factory's create function receives pre-resolved fields (temp IDs replaced with real IDs)
 * and must return at least the primary key field.
 */
public class FactoryDefinition {

    private final FactoryCreateFn create;
    private final FactoryTeardownFn teardown;

    public FactoryDefinition(FactoryCreateFn create, FactoryTeardownFn teardown) {
        this.create = create;
        this.teardown = teardown;
    }

    public FactoryCreateFn getCreate() { return create; }
    public FactoryTeardownFn getTeardown() { return teardown; }

    /**
     * Functional interface for creating a single entity.
     * Receives pre-resolved fields (temp IDs already replaced). Must return at least { id }.
     */
    @FunctionalInterface
    public interface FactoryCreateFn {
        Map<String, Object> create(Map<String, Object> data, FactoryContext ctx) throws Exception;
    }

    /**
     * Functional interface for tearing down a single entity record.
     * If omitted, falls back to SQL DELETE.
     */
    @FunctionalInterface
    public interface FactoryTeardownFn {
        void teardown(Map<String, Object> record, FactoryContext ctx) throws Exception;
    }
}
