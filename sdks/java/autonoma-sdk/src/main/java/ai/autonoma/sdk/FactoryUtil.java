package ai.autonoma.sdk;

import ai.autonoma.sdk.types.FactoryDefinition;

/**
 * Helper for defining entity factories.
 *
 * <p>Every factory must declare an {@code inputClass}: the SDK validates inputs
 * through Jackson {@code ObjectMapper.convertValue(data, inputClass)} before
 * calling create, and uses the same class to derive the discover schema via
 * reflection. There is no automatic fallback.
 */
public final class FactoryUtil {

    private FactoryUtil() {}

    /**
     * Define a factory with a create function and input class.
     *
     * @param create     the create function (required)
     * @param inputClass the input model class for validation and schema (required)
     * @return the factory definition
     */
    public static FactoryDefinition defineFactory(FactoryDefinition.FactoryCreateFn create,
                                                   Class<?> inputClass) {
        return defineFactory(create, inputClass, null, null);
    }

    /**
     * Define a factory with create, input class, and teardown.
     *
     * @param create     the create function (required)
     * @param inputClass the input model class for validation and schema (required)
     * @param teardown   the teardown function (optional, may be null)
     * @return the factory definition
     */
    public static FactoryDefinition defineFactory(FactoryDefinition.FactoryCreateFn create,
                                                   Class<?> inputClass,
                                                   FactoryDefinition.FactoryTeardownFn teardown) {
        return defineFactory(create, inputClass, teardown, null);
    }

    /**
     * Define a factory with create, input class, teardown, and ref class.
     *
     * @param create     the create function (required)
     * @param inputClass the input model class for validation and schema (required)
     * @param teardown   the teardown function (optional, may be null)
     * @param refClass   the ref model class for teardown validation (optional, may be null)
     * @return the factory definition
     */
    public static FactoryDefinition defineFactory(FactoryDefinition.FactoryCreateFn create,
                                                   Class<?> inputClass,
                                                   FactoryDefinition.FactoryTeardownFn teardown,
                                                   Class<?> refClass) {
        if (create == null) {
            throw new IllegalArgumentException("Factory definition must include a \"create\" function");
        }
        if (inputClass == null) {
            throw new IllegalArgumentException(
                "Factory must declare `inputClass`. The SDK derives the discover schema from it; there is no automatic fallback.");
        }
        return new FactoryDefinition(create, teardown, inputClass, refClass);
    }
}
