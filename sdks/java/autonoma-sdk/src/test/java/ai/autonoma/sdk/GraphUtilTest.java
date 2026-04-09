package ai.autonoma.sdk;

import ai.autonoma.sdk.types.FKEdge;
import ai.autonoma.sdk.types.TopoSortResult;
import org.junit.jupiter.api.Test;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class GraphUtilTest {

    @Test
    void topoSort_linearChain() {
        List<String> nodes = List.of("A", "B", "C");
        List<FKEdge> edges = List.of(
            new FKEdge("B", "A", "aId", "id", false),
            new FKEdge("C", "B", "bId", "id", false)
        );
        TopoSortResult result = GraphUtil.topoSort(nodes, edges);
        assertEquals(List.of("A", "B", "C"), result.sorted());
        assertTrue(result.cycles().isEmpty());
    }

    @Test
    void topoSort_noDependencies() {
        List<String> nodes = List.of("X", "Y", "Z");
        List<FKEdge> edges = List.of();
        TopoSortResult result = GraphUtil.topoSort(nodes, edges);
        assertEquals(3, result.sorted().size());
        assertTrue(result.cycles().isEmpty());
    }

    @Test
    void topoSort_detectsCycle() {
        List<String> nodes = List.of("A", "B");
        List<FKEdge> edges = List.of(
            new FKEdge("A", "B", "bId", "id", true),
            new FKEdge("B", "A", "aId", "id", false)
        );
        TopoSortResult result = GraphUtil.topoSort(nodes, edges);
        assertFalse(result.cycles().isEmpty());
    }

    @Test
    void findDeferrableEdge_returnsNullable() {
        List<String> cycle = List.of("A", "B");
        List<FKEdge> edges = List.of(
            new FKEdge("A", "B", "bId", "id", true),
            new FKEdge("B", "A", "aId", "id", false)
        );
        FKEdge edge = GraphUtil.findDeferrableEdge(cycle, edges);
        assertNotNull(edge);
        assertTrue(edge.nullable());
    }

    @Test
    void findDeferrableEdge_returnsNullWhenNoneNullable() {
        List<String> cycle = List.of("A", "B");
        List<FKEdge> edges = List.of(
            new FKEdge("A", "B", "bId", "id", false),
            new FKEdge("B", "A", "aId", "id", false)
        );
        FKEdge edge = GraphUtil.findDeferrableEdge(cycle, edges);
        assertNull(edge);
    }
}
