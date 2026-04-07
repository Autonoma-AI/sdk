package ai.autonoma.conformance;

import ai.autonoma.sdk.*;
import ai.autonoma.sdk.types.FKEdge;
import ai.autonoma.sdk.types.TopoSortResult;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * Conformance test bridge for the Java SDK.
 * Reads JSON from stdin, dispatches to the appropriate module/function,
 * and writes the result as JSON to stdout.
 */
public class Bridge {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @SuppressWarnings("unchecked")
    public static void main(String[] args) {
        try {
            String input = new BufferedReader(new InputStreamReader(System.in))
                .lines().collect(Collectors.joining("\n"));

            Map<String, Object> request = MAPPER.readValue(input, new TypeReference<>() {});
            String module = (String) request.get("module");
            String function = (String) request.get("function");
            Map<String, Object> inputData = (Map<String, Object>) request.get("input");

            String key = module + "." + function;
            Object result;

            switch (key) {
                case "graph.topoSort" -> {
                    List<String> nodes = (List<String>) inputData.get("nodes");
                    List<Map<String, Object>> edgesRaw = (List<Map<String, Object>>) inputData.get("edges");
                    List<FKEdge> edges = edgesRaw.stream().map(e -> new FKEdge(
                        (String) e.get("from"), (String) e.get("to"),
                        (String) e.get("localField"), (String) e.get("foreignField"),
                        Boolean.TRUE.equals(e.get("nullable"))
                    )).toList();
                    TopoSortResult sortResult = GraphUtil.topoSort(nodes, edges);
                    Map<String, Object> resultMap = new LinkedHashMap<>();
                    resultMap.put("sorted", sortResult.sorted());
                    resultMap.put("cycles", sortResult.cycles());
                    result = resultMap;
                }
                case "graph.findDeferrableEdge" -> {
                    List<String> cycle = (List<String>) inputData.get("cycle");
                    List<Map<String, Object>> edgesRaw = (List<Map<String, Object>>) inputData.get("edges");
                    List<FKEdge> edges = edgesRaw.stream().map(e -> new FKEdge(
                        (String) e.get("from"), (String) e.get("to"),
                        (String) e.get("localField"), (String) e.get("foreignField"),
                        Boolean.TRUE.equals(e.get("nullable"))
                    )).toList();
                    FKEdge edge = GraphUtil.findDeferrableEdge(cycle, edges);
                    if (edge == null) {
                        result = null;
                    } else {
                        Map<String, Object> edgeMap = new LinkedHashMap<>();
                        edgeMap.put("from", edge.from());
                        edgeMap.put("to", edge.to());
                        edgeMap.put("localField", edge.localField());
                        edgeMap.put("foreignField", edge.foreignField());
                        edgeMap.put("nullable", edge.nullable());
                        result = edgeMap;
                    }
                }
                case "hmac.signBody" -> {
                    result = HmacUtil.signBody((String) inputData.get("body"), (String) inputData.get("secret"));
                }
                case "hmac.verifySignature" -> {
                    result = HmacUtil.verifySignature(
                        (String) inputData.get("body"),
                        (String) inputData.get("signature"),
                        (String) inputData.get("secret")
                    );
                }
                case "refs.signRefs" -> {
                    Map<String, Object> payload = (Map<String, Object>) inputData.get("payload");
                    result = RefsUtil.signRefs(payload, (String) inputData.get("secret"));
                }
                case "refs.verifyRefs" -> {
                    result = RefsUtil.verifyRefs((String) inputData.get("token"), (String) inputData.get("secret"));
                }
                case "fingerprint.fingerprint" -> {
                    result = FingerprintUtil.fingerprint(inputData.get("value"));
                }
                case "template.resolveTemplate" -> {
                    Map<String, Object> ctx = (Map<String, Object>) inputData.get("ctx");
                    String testRunId = (String) ctx.get("testRunId");
                    int index = ((Number) ctx.get("index")).intValue();
                    result = TemplateResolver.resolveTemplate(inputData.get("value"), testRunId, index);
                }
                default -> throw new RuntimeException("Unknown function: " + key);
            }

            Map<String, Object> output = new LinkedHashMap<>();
            output.put("ok", true);
            output.put("result", result);
            System.out.println(MAPPER.writeValueAsString(output));

        } catch (Exception e) {
            try {
                Map<String, Object> output = new LinkedHashMap<>();
                output.put("ok", false);
                output.put("error", e.getMessage());
                System.out.println(MAPPER.writeValueAsString(output));
            } catch (Exception e2) {
                System.out.println("{\"ok\":false,\"error\":\"" + e2.getMessage() + "\"}");
            }
        }
    }
}
