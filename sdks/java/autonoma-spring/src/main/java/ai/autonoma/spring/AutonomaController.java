package ai.autonoma.spring;

import ai.autonoma.sdk.AutonomaHandler;
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
 *     public AutonomaController autonomaController(DataSource dataSource) {
 *         SQLExecutor executor = new JdbcSQLExecutor(dataSource);
 *         HandlerConfig config = new HandlerConfig(executor, "organizationId", sharedSecret, signingSecret,
 *             (user, ctx) -> AuthResult.ofHeaders(Map.of("Authorization", "Bearer " + generateToken(user))));
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
            currentSdk != null ? currentSdk.orm() : "jdbc",
            "spring"
        );
        this.config = config.withSdk(enriched);
    }

    @PostMapping(value = "${autonoma.endpoint:/api/autonoma}",
                 consumes = MediaType.APPLICATION_JSON_VALUE,
                 produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Map<String, Object>> handle(
            @RequestBody String body,
            HttpServletRequest request) {

        Map<String, String> headers = extractHeaders(request);
        HandlerRequest handlerReq = new HandlerRequest(body, headers);
        HandlerResponse result = AutonomaHandler.handleRequest(config, handlerReq);

        return ResponseEntity.status(result.status()).body(result.body());
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
