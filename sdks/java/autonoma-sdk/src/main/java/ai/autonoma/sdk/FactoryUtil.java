package ai.autonoma.sdk;

import ai.autonoma.sdk.types.FactoryDefinition;

/**
 * Helper for defining entity factories.
 */
public final class FactoryUtil {

    private FactoryUtil() {}

    /**
     * Define a factory for creating entities via user code instead of raw SQL.
     * The factory's create function receives pre-resolved fields (temp IDs replaced with real IDs)
     * and must return at least the primary key field.
     *
     * @param create  the create function (required)
     * @return the factory definition
     */
    public static FactoryDefinition defineFactory(FactoryDefinition.FactoryCreateFn create) {
        return defineFactory(create, null);
    }

    /**
     * Define a factory with both create and teardown functions.
     *
     * @param create   the create function (required)
     * @param teardown the teardown function (optional, may be null)
     * @return the factory definition
     */
    public static FactoryDefinition defineFactory(FactoryDefinition.FactoryCreateFn create,
                                                   FactoryDefinition.FactoryTeardownFn teardown) {
        if (create == null) {
            throw new IllegalArgumentException("Factory definition must include a \"create\" function");
        }
        return new FactoryDefinition(create, teardown);
    }
}
