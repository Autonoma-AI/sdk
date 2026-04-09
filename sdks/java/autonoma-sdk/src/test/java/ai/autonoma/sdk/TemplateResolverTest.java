package ai.autonoma.sdk;

import org.junit.jupiter.api.Test;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class TemplateResolverTest {

    @Test
    void resolveTestRunId() {
        Object result = TemplateResolver.resolveTemplate("{{testRunId}}", "abc-123", 0);
        assertEquals("abc-123", result);
    }

    @Test
    void resolveIndex() {
        Object result = TemplateResolver.resolveTemplate("{{index}}", "t", 5);
        assertEquals(5, result);
    }

    @Test
    void resolveIndex1() {
        Object result = TemplateResolver.resolveTemplate("{{index1}}", "t", 5);
        assertEquals(6, result);
    }

    @Test
    void resolveCycle() {
        Object result = TemplateResolver.resolveTemplate("{{cycle(['a','b','c'])}}", "t", 4);
        assertEquals("b", result);
    }

    @Test
    void resolveRandomInt() {
        Object result = TemplateResolver.resolveTemplate("{{random.int(1,10)}}", "t", 0);
        assertInstanceOf(Integer.class, result);
        int val = (int) result;
        assertTrue(val >= 1 && val <= 10);
    }

    @Test
    void resolveNow() {
        Object result = TemplateResolver.resolveTemplate("{{now()}}", "t", 0);
        assertInstanceOf(String.class, result);
        assertTrue(((String) result).contains("T")); // ISO format
    }

    @Test
    void resolveInterpolation() {
        Object result = TemplateResolver.resolveTemplate("user-{{testRunId}}-{{index}}", "xyz", 3);
        assertEquals("user-xyz-3", result);
    }

    @Test
    void resolveMap() {
        Map<String, Object> input = Map.of("name", "{{testRunId}}", "age", 42);
        Object result = TemplateResolver.resolveTemplate(input, "tid", 0);
        assertInstanceOf(Map.class, result);
        @SuppressWarnings("unchecked")
        Map<String, Object> map = (Map<String, Object>) result;
        assertEquals("tid", map.get("name"));
        assertEquals(42, map.get("age"));
    }

    @Test
    void unknownExpression_throws() {
        assertThrows(RuntimeException.class,
            () -> TemplateResolver.resolveTemplate("{{unknown_expr}}", "t", 0));
    }
}
