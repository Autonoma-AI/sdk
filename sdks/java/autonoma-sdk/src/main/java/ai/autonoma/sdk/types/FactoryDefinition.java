package ai.autonoma.sdk.types;

import java.util.Map;

/**
 * A factory for creating entities via user code.
 *
 * <p>{@code inputClass} is required: the SDK validates fields through Jackson
 * {@code ObjectMapper.convertValue(data, inputClass)} before invoking create,
 * and uses the same class to derive the discover schema via reflection.
 *
 * <p>{@code refClass} is optional: when provided, the SDK converts the stored
 * record through it before invoking teardown.
 */
public class FactoryDefinition {

    private final FactoryCreateFn create;
    private final FactoryTeardownFn teardown;
    private final Class<?> inputClass;
    private final Class<?> refClass;

    public FactoryDefinition(FactoryCreateFn create, FactoryTeardownFn teardown,
                             Class<?> inputClass, Class<?> refClass) {
        this.create = create;
        this.teardown = teardown;
        this.inputClass = inputClass;
        this.refClass = refClass;
    }

    public FactoryCreateFn getCreate() { return create; }
    public FactoryTeardownFn getTeardown() { return teardown; }
    public Class<?> getInputClass() { return inputClass; }
    public Class<?> getRefClass() { return refClass; }

    /**
     * Functional interface for creating a single entity.
     * Receives a validated, typed input object and a context. Must return a Map with at least "id".
     */
    @FunctionalInterface
    public interface FactoryCreateFn {
        Map<String, Object> create(Object data, FactoryContext ctx) throws Exception;
    }

    /**
     * Functional interface for tearing down a single entity record.
     */
    @FunctionalInterface
    public interface FactoryTeardownFn {
        void teardown(Object record, FactoryContext ctx) throws Exception;
    }
}
