package ai.autonoma.sdk;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class UniqueUtilTest {

    // These vectors are cross-checked against the TypeScript unique.ts recipe so
    // the same (testRunId, ...parts) yields byte-identical output across languages.
    @Test
    void crossLanguageVectors() {
        assertEquals("4e65d3fbe8ad", UniqueUtil.uniqueToken("run-1"));
        assertEquals("user+039af36014b8@example.com", UniqueUtil.uniqueEmail("run-1", null, null));
        assertEquals("acme-b6446df155f8", UniqueUtil.uniqueSlug("run-1", "Acme"));
        assertEquals("user_776b5cbfd0f0", UniqueUtil.uniqueId("run-1", "user"));
    }

    @Test
    void tokenShape() {
        String token = UniqueUtil.uniqueToken("run", "a", "b");
        assertEquals(12, token.length());
        assertTrue(token.matches("^[0-9a-f]{12}$"), () -> "token " + token + " is not 12 lowercase hex chars");
    }

    @Test
    void deterministicAndSeeded() {
        assertEquals(UniqueUtil.uniqueToken("run", "x"), UniqueUtil.uniqueToken("run", "x"));
        assertNotEquals(UniqueUtil.uniqueToken("run-a", "x"), UniqueUtil.uniqueToken("run-b", "x"));
        assertNotEquals(UniqueUtil.uniqueToken("run", "x"), UniqueUtil.uniqueToken("run", "y"));
    }

    @Test
    void slugNormalization() {
        String slug = UniqueUtil.uniqueSlug("run", "Acme Corp!!");
        assertTrue(slug.matches("^acme-corp-[0-9a-f]{12}$"), () -> "slug " + slug + " not normalized as expected");

        // A base that normalizes to empty falls back to "item".
        String fallback = UniqueUtil.uniqueSlug("run", "!!!");
        assertTrue(fallback.matches("^item-[0-9a-f]{12}$"), () -> "empty-normalized base should fall back to item, got " + fallback);
    }
}
