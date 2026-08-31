package ai.autonoma.spring;

import ai.autonoma.sdk.AutonomaHandler;
import ai.autonoma.sdk.RefsUtil;
import ai.autonoma.sdk.types.HandlerConfig;
import ai.autonoma.sdk.types.HandlerRequest;
import ai.autonoma.sdk.types.HandlerResponse;
import ai.autonoma.sdk.types.SdkInfo;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Spring Boot REST controller that handles the Autonoma Environment Factory protocol.
 *
 * <p>Usage:
 * <pre>{@code
 * @Configuration
 * public class AutonomaConfig {
 *     @Bean
 *     public AutonomaController autonomaController() {
 *         HandlerConfig config = new HandlerConfig(sharedSecret, signingSecret, List.of(
 *             Scenario.define("single-user", "One verified user in a fresh org",
 *                 ctx -> new ScenarioUpResult(
 *                     AuthResult.ofHeaders(Map.of("Authorization", "Bearer " + mintToken(ctx.testRunId()))),
 *                     Map.of("userId", userId)),
 *                 ctx -> deleteUser((String) ctx.teardown().get("userId")))));
 *         return new AutonomaController(config);
 *     }
 * }
 * }</pre>
 */
@RestController
public class AutonomaController {

    private final HandlerConfig config;

    public AutonomaController(HandlerConfig config) {
        SdkInfo currentSdk = config.getSdk();
        SdkInfo enriched = new SdkInfo(
            "java",
            currentSdk != null ? currentSdk.orm() : "unknown",
            "spring"
        );
        this.config = config.withSdk(enriched);
    }

    @PostMapping(value = "${autonoma.endpoint:/api/autonoma}",
                 consumes = MediaType.APPLICATION_JSON_VALUE,
                 produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<String> handle(
            @RequestBody String body,
            HttpServletRequest request) {

        Map<String, String> headers = extractHeaders(request);
        HandlerRequest handlerReq = new HandlerRequest(body, headers);
        HandlerResponse result = AutonomaHandler.handleRequest(config, handlerReq);

        return ResponseEntity.status(result.status())
                .contentType(MediaType.APPLICATION_JSON)
                .body(RefsUtil.serializeToJson(result.body()));
    }

    private static Map<String, String> extractHeaders(HttpServletRequest request) {
        Map<String, String> headers = new LinkedHashMap<>();
        Enumeration<String> headerNames = request.getHeaderNames();
        while (headerNames.hasMoreElements()) {
            String name = headerNames.nextElement();
            headers.put(name.toLowerCase(Locale.ROOT), request.getHeader(name));
        }
        return headers;
    }
}
