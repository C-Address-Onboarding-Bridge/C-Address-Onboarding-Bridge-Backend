package com.caddressbridge;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

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
    private final ObjectMapper mapper = new ObjectMapper();

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

    public JsonNode request(String method, String path, Map<String, String> query, Object jsonBody)
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
            builder.method(method, HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(jsonBody)));
        } else {
            builder.method(method, HttpRequest.BodyPublishers.noBody());
        }
        HttpResponse<String> resp = http.send(builder.build(), HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() < 200 || resp.statusCode() >= 300) {
            throw BridgeException.fromResponse(resp.statusCode(), resp.body());
        }
        String body = resp.body();
        if (body == null || body.isBlank()) {
            return mapper.createObjectNode();
        }
        return mapper.readTree(body);
    }

    public JsonNode health() throws IOException, InterruptedException, BridgeException {
        return request("GET", "/health", null, null);
    }

    public JsonNode getQuote(String sourceAsset, String amount, String targetAddress)
            throws IOException, InterruptedException, BridgeException {
        return request("GET", "/api/v1/quote", Map.of(
                "sourceAsset", sourceAsset,
                "amount", amount,
                "targetAddress", targetAddress
        ), null);
    }

    public JsonNode prepareFunding(String source, String target, String token, String amount, String memo)
            throws IOException, InterruptedException, BridgeException {
        ObjectNode body = mapper.createObjectNode();
        body.put("sourceAddress", source);
        body.put("targetAddress", target);
        body.put("tokenAddress", token);
        body.put("amount", amount);
        body.put("memo", memo);
        return request("POST", "/api/v1/fund/prepare", null, body);
    }

    public JsonNode submitSignedXdr(String signedXdr)
            throws IOException, InterruptedException, BridgeException {
        ObjectNode body = mapper.createObjectNode();
        body.put("signedXdr", signedXdr);
        return request("POST", "/api/v1/fund", null, body);
    }

    public JsonNode getStatus(String txHash) throws IOException, InterruptedException, BridgeException {
        return request("GET", "/api/v1/status/" + txHash, null, null);
    }

    public JsonNode createMoonpayUrl(Object jsonBody) throws IOException, InterruptedException, BridgeException {
        return request("POST", "/api/v1/offramp/moonpay", null, jsonBody);
    }

    public JsonNode createTransakUrl(Object jsonBody) throws IOException, InterruptedException, BridgeException {
        return request("POST", "/api/v1/offramp/transak", null, jsonBody);
    }
}
