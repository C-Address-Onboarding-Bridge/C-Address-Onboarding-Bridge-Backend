package com.bridge.example;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.UUID;

/**
 * Minimal example client for the C-Address Onboarding Bridge API.
 *
 * <p>Every mutating call ({@code /api/v1/fund}, {@code /api/v1/cex/route}) sends an
 * {@code Idempotency-Key} header so the server can de-duplicate retries. Generate the key
 * once per logical request and reuse it when retrying that same request.
 */
public class BridgeClient {

    private static final String IDEMPOTENCY_HEADER = "Idempotency-Key";

    private final HttpClient http;
    private final String baseUrl;
    private final String apiKey;

    public BridgeClient(String baseUrl, String apiKey) {
        this.baseUrl = baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl;
        this.apiKey = apiKey;
        this.http = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .build();
    }

    /**
     * Submit a funding request.
     *
     * @param body JSON request body
     * @return the raw JSON response body
     */
    public String fund(String body) throws IOException, InterruptedException {
        return post("/api/v1/fund", body, newIdempotencyKey());
    }

    /**
     * Submit a CEX route request.
     *
     * @param body JSON request body
     * @return the raw JSON response body
     */
    public String cexRoute(String body) throws IOException, InterruptedException {
        return post("/api/v1/cex/route", body, newIdempotencyKey());
    }

    /**
     * Retry a previously submitted request, reusing the original idempotency key so the
     * server treats it as the same logical operation.
     */
    public String retry(String path, String body, String idempotencyKey)
            throws IOException, InterruptedException {
        return post(path, body, idempotencyKey);
    }

    private String post(String path, String body, String idempotencyKey)
            throws IOException, InterruptedException {
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(baseUrl + path))
                .timeout(Duration.ofSeconds(30))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + apiKey)
                .header(IDEMPOTENCY_HEADER, idempotencyKey)
                .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
                .build();

        HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() >= 400) {
            throw new IOException("request to " + path + " failed: HTTP " + response.statusCode()
                    + " " + response.body());
        }
        return response.body();
    }

    private static String newIdempotencyKey() {
        return UUID.randomUUID().toString();
    }

    public static void main(String[] args) throws Exception {
        String baseUrl = System.getenv().getOrDefault("BRIDGE_BASE_URL", "http://localhost:8080");
        String apiKey = System.getenv().getOrDefault("BRIDGE_API_KEY", "");

        BridgeClient client = new BridgeClient(baseUrl, apiKey);

        String fundBody = "{\"address\":\"0x0000000000000000000000000000000000000000\",\"amount\":\"1000000\"}";
        System.out.println(client.fund(fundBody));

        String routeBody = "{\"address\":\"0x0000000000000000000000000000000000000000\",\"asset\":\"USDC\"}";
        System.out.println(client.cexRoute(routeBody));
    }
}
