package ai.autonoma.conformance;

import ai.autonoma.sdk.HmacUtil;
import ai.autonoma.sdk.RefsUtil;
import ai.autonoma.sdk.UniqueUtil;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * Conformance test bridge for the Java SDK (Scenario v2).
 *
 * <p>Reads JSON from stdin, dispatches to the appropriate module/function, and
 * writes the result as JSON to stdout. Scenario v2 dropped the create-graph
 * interpreter and fingerprinting; the bridge conforms on the version-agnostic
 * {@code hmac}, {@code refs}, and {@code unique} primitives.
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
                    Map<String, Object> payload =
                        RefsUtil.verifyRefs((String) inputData.get("token"), (String) inputData.get("secret"));
                    Map<String, Object> out = new LinkedHashMap<>();
                    out.put("refs", payload.get("refs"));
                    out.put("testRunId", payload.get("testRunId"));
                    out.put("environment", payload.get("environment"));
                    result = out;
                }
                case "unique.uniqueToken" -> {
                    result = UniqueUtil.uniqueToken(
                        (String) inputData.get("testRunId"), toStringArray(inputData.get("parts")));
                }
                case "unique.uniqueId" -> {
                    result = UniqueUtil.uniqueId(
                        (String) inputData.get("testRunId"),
                        (String) inputData.get("prefix"),
                        toStringArray(inputData.get("parts")));
                }
                case "unique.uniqueSlug" -> {
                    result = UniqueUtil.uniqueSlug(
                        (String) inputData.get("testRunId"),
                        (String) inputData.get("base"),
                        toStringArray(inputData.get("parts")));
                }
                case "unique.uniqueEmail" -> {
                    result = UniqueUtil.uniqueEmail(
                        (String) inputData.get("testRunId"),
                        (String) inputData.get("local"),
                        (String) inputData.get("domain"));
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

    /** JSON arrays decode as {@code List<Object>}; the unique helpers take a {@code String...} tail. */
    private static String[] toStringArray(Object parts) {
        if (!(parts instanceof java.util.List<?> list)) {
            return new String[0];
        }
        return list.stream().map(String::valueOf).toArray(String[]::new);
    }
}
