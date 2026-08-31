package ai.autonoma.conformance;

import ai.autonoma.sdk.AutonomaHandler;
import ai.autonoma.sdk.RefsUtil;
import ai.autonoma.sdk.Scenario;
import ai.autonoma.sdk.types.AuthResult;
import ai.autonoma.sdk.types.HandlerConfig;
import ai.autonoma.sdk.types.HandlerRequest;
import ai.autonoma.sdk.types.HandlerResponse;
import ai.autonoma.sdk.types.ScenarioUpResult;
import ai.autonoma.sdk.types.SdkInfo;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Minimal JDK {@code com.sun.net.httpserver} server that runs the Java SDK's
 * v2 handler with a couple of scenarios. Used by run-suites.mjs to exercise the
 * shared protocol/suites/* against a real Java endpoint. It mirrors
 * protocol/servers/go-server.go and ruby-server.rb.
 */
public final class ProtocolServer {

    private ProtocolServer() {}

    public static void main(String[] args) throws IOException {
        String sharedSecret = getenv("AUTONOMA_SHARED_SECRET", "protocol-shared");
        String signingSecret = getenv("AUTONOMA_SIGNING_SECRET", "protocol-signing");
        int port = Integer.parseInt(getenv("PORT", "4594"));

        HandlerConfig config = new HandlerConfig(sharedSecret, signingSecret, List.of(
            Scenario.define(
                "standard",
                "A standard seeded environment",
                ctx -> new ScenarioUpResult(
                    AuthResult.ofHeaders(Map.of("Authorization", "Bearer token-" + ctx.testRunId())),
                    Map.of("userId", "user-" + ctx.testRunId())),
                ctx -> {}),
            Scenario.define(
                "empty",
                "Nothing seeded",
                ctx -> ScenarioUpResult.empty())
        )).setSdk(new SdkInfo("java", "none", "com.sun.net.httpserver"));

        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
        server.createContext("/", exchange -> handle(exchange, config));
        server.setExecutor(null);
        server.start();
        System.out.println("java-server listening on " + port);
    }

    private static void handle(HttpExchange exchange, HandlerConfig config) throws IOException {
        try (InputStream is = exchange.getRequestBody()) {
            String body = new String(is.readAllBytes(), StandardCharsets.UTF_8);

            Map<String, String> headers = new LinkedHashMap<>();
            exchange.getRequestHeaders().forEach((key, values) -> {
                if (values != null && !values.isEmpty()) {
                    headers.put(key.toLowerCase(Locale.ROOT), values.get(0));
                }
            });

            HandlerResponse result = AutonomaHandler.handleRequest(config, new HandlerRequest(body, headers));
            byte[] out = RefsUtil.serializeToJson(result.body()).getBytes(StandardCharsets.UTF_8);

            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(result.status(), out.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(out);
            }
        } catch (Exception e) {
            byte[] out = ("{\"error\":\"internal error\",\"code\":\"INTERNAL_ERROR\"}")
                .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(500, out.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(out);
            }
        }
    }

    private static String getenv(String key, String fallback) {
        String v = System.getenv(key);
        return (v != null && !v.isEmpty()) ? v : fallback;
    }
}
