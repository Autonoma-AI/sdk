package ai.autonoma.sdk;

import org.junit.jupiter.api.Test;

import java.util.*;

import static org.junit.jupiter.api.Assertions.*;

class TokenResolutionTest {

    @Test
    @SuppressWarnings("unchecked")
    void testRunIdSubstituted() {
        Map<String, Object> input = new LinkedHashMap<>();
        input.put("email", "alice-{{testRunId}}@test.local");
        Map<String, Object> out = (Map<String, Object>) AutonomaHandler.resolveTokens(input, "run-123", 0);
        assertEquals("alice-run-123@test.local", out.get("email"));
    }

    @Test
    @SuppressWarnings("unchecked")
    void indexSubstituted() {
        Map<String, Object> input = new LinkedHashMap<>();
        input.put("slot", "pos-{{index}}");
        Map<String, Object> out = (Map<String, Object>) AutonomaHandler.resolveTokens(input, "r", 4);
        assertEquals("pos-4", out.get("slot"));
    }

    @Test
    void cycleSubstitutedAndWraps() {
        assertEquals("a", AutonomaHandler.resolveTokens("{{cycle(a,b)}}", "r", 0));
        assertEquals("b", AutonomaHandler.resolveTokens("{{cycle(a,b)}}", "r", 1));
        assertEquals("a", AutonomaHandler.resolveTokens("{{cycle(a,b)}}", "r", 2));
    }

    @Test
    void cycleQuotedValuesStripped() {
        assertEquals("IOS", AutonomaHandler.resolveTokens("{{cycle('WEB','IOS','ANDROID')}}", "r", 1));
    }

    @Test
    @SuppressWarnings("unchecked")
    void nestedStructuresWalked() {
        Map<String, Object> user1 = new LinkedHashMap<>();
        user1.put("email", "u-{{testRunId}}@t.local");
        Map<String, Object> user2 = new LinkedHashMap<>();
        user2.put("email", "v-{{testRunId}}@t.local");
        Map<String, Object> input = new LinkedHashMap<>();
        input.put("users", List.of(user1, user2));
        input.put("tags", List.of("{{testRunId}}-a", "{{testRunId}}-b"));

        Map<String, Object> out = (Map<String, Object>) AutonomaHandler.resolveTokens(input, "xyz", 0);
        List<Map<String, Object>> users = (List<Map<String, Object>>) out.get("users");
        assertEquals("u-xyz@t.local", users.get(0).get("email"));
        assertEquals("v-xyz@t.local", users.get(1).get("email"));
        List<String> tags = (List<String>) out.get("tags");
        assertEquals(List.of("xyz-a", "xyz-b"), tags);
    }

    @Test
    void multipleTokensInOneString() {
        assertEquals("run-7", AutonomaHandler.resolveTokens("{{testRunId}}-{{index}}", "run", 7));
    }

    @Test
    void unknownTokenRaises() {
        Map<String, Object> input = new LinkedHashMap<>();
        input.put("x", "hello-{{mystery}}");
        AutonomaError err = assertThrows(AutonomaError.class, () ->
            AutonomaHandler.resolveTokens(input, "r", 0));
        assertEquals("UNRESOLVED_TOKEN", err.getCode());
        assertTrue(err.getMessage().contains("mystery"));
    }

    @Test
    void nonStringPrimitivesPassThrough() {
        assertEquals(42, AutonomaHandler.resolveTokens(42, "r", 0));
        assertEquals(Boolean.TRUE, AutonomaHandler.resolveTokens(Boolean.TRUE, "r", 0));
        assertNull(AutonomaHandler.resolveTokens(null, "r", 0));
    }

    @Test
    void stringWithoutTokensUnchanged() {
        assertEquals("plain string", AutonomaHandler.resolveTokens("plain string", "r", 0));
    }
}
