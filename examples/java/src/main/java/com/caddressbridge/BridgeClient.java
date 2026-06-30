package com.caddressbridge;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;
import java.util.stream.Collectors;

public final class BridgeClient {
    private final String baseUrl;
    private final String apiKey;
    private final HttpClient http;

    public BridgeClient(String baseUrl, String apiKey) {
        this.baseUrl = baseUrl.replaceAll("/+$", "");
        this.apiKey = apiKey;
        this.http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(30)).build();
    }

    public static BridgeClient fromEnv() {
        String baseUrl = System.getenv().getOrDefault("BRIDGE_BASE_URL", "http://localhost:3099");
        String apiKey = System.getenv("BRIDGE_API_KEY");
        return new BridgeClient(baseUrl, apiKey);
    }

    public String request(String method, String path, Map<String, String> query, String jsonBody)
            throws IOException, InterruptedException, BridgeException {
        String url = baseUrl + path;
        if (query != null && !query.isEmpty()) {
            String qs = query.entrySet().stream()
                    .map(e -> URLEncoder.encode(e.getKey(), StandardCharsets.UTF_8) + "="
                            + URLEncoder.encode(e.getValue(), StandardCharsets.UTF_8))
                    .collect(Collectors.joining("&"));
            url += "?" + qs;
        }
        HttpRequest.Builder builder = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .timeout(Duration.ofSeconds(30))
                .header("Accept", "application/json")
                .header("Content-Type", "application/json");
        if (apiKey != null && !apiKey.isBlank()) {
            builder.header("X-API-Key", apiKey);
        }
        if (jsonBody != null) {
            builder.method(method, HttpRequest.BodyPublishers.ofString(jsonBody));
        } else {
            builder.method(method, HttpRequest.BodyPublishers.noBody());
        }
        HttpResponse<String> resp = http.send(builder.build(), HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() < 200 || resp.statusCode() >= 300) {
            throw BridgeException.fromResponse(resp.statusCode(), resp.body());
        }
        return resp.body();
    }

    public String health() throws IOException, InterruptedException, BridgeException {
        return request("GET", "/health", null, null);
    }

    public String getQuote(String sourceAsset, String amount, String targetAddress)
            throws IOException, InterruptedException, BridgeException {
        return request("GET", "/api/v1/quote", Map.of(
                "sourceAsset", sourceAsset,
                "amount", amount,
                "targetAddress", targetAddress
        ), null);
    }

    public String prepareFunding(String source, String target, String token, String amount, String memo)
            throws IOException, InterruptedException, BridgeException {
        String body = String.format(
                "{\"sourceAddress\":\"%s\",\"targetAddress\":\"%s\",\"tokenAddress\":\"%s\",\"amount\":\"%s\",\"memo\":\"%s\"}",
                source, target, token, amount, memo
        );
        return request("POST", "/api/v1/fund/prepare", null, body);
    }

    public String submitSignedXdr(String signedXdr)
            throws IOException, InterruptedException, BridgeException {
        return request("POST", "/api/v1/fund", null, "{\"signedXdr\":\"" + signedXdr + "\"}");
    }

    public String getStatus(String txHash) throws IOException, InterruptedException, BridgeException {
        return request("GET", "/api/v1/status/" + txHash, null, null);
    }

    public String createMoonpayUrl(String jsonBody) throws IOException, InterruptedException, BridgeException {
        return request("POST", "/api/v1/offramp/moonpay", null, jsonBody);
    }

    public String createTransakUrl(String jsonBody) throws IOException, InterruptedException, BridgeException {
        return request("POST", "/api/v1/offramp/transak", null, jsonBody);
    }
}
