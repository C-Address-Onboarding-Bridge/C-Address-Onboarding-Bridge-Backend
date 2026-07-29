package com.caddressbridge.example;

import com.caddressbridge.BridgeClient;
import com.caddressbridge.BridgeException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

public final class Example {
    private static final String MOCK_C_ADDRESS =
            "CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTU";
    private static final String MOCK_G_ADDRESS =
            "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTU";
    private static final String MOCK_TOKEN_ADDRESS =
            "CATOKEN7ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMN";

    private static final ObjectMapper MAPPER = new ObjectMapper();

    public static void main(String[] args) {
        BridgeClient client = BridgeClient.fromEnv();
        System.out.println("Bridge client ready");
        try {
            System.out.println("Health: " + client.health());
            System.out.println("Quote: " + client.getQuote("XLM", "10000000", MOCK_C_ADDRESS));
            System.out.println("Prepared: " + client.prepareFunding(
                    MOCK_G_ADDRESS, MOCK_C_ADDRESS, MOCK_TOKEN_ADDRESS, "10000000", "onboarding"));
            JsonNode funded = client.submitSignedXdr("AAAAAgAAAABexampleSignedTransactionXdr");
            System.out.println("Funded: " + funded);
            JsonNode hashNode = funded.get("hash");
            if (hashNode == null || hashNode.isNull()) {
                throw new BridgeException(0, "submitSignedXdr response did not contain a \"hash\" field");
            }
            String hash = hashNode.asText();
            System.out.println("Status: " + client.getStatus(hash));

            ObjectNode moonpayBody = MAPPER.createObjectNode();
            moonpayBody.put("walletAddress", MOCK_C_ADDRESS);
            moonpayBody.put("currencyCode", "xlm");
            moonpayBody.put("walletNetwork", "stellar");
            moonpayBody.put("baseCurrencyAmount", 100);
            moonpayBody.put("baseCurrencyCode", "USD");
            System.out.println("MoonPay: " + client.createMoonpayUrl(moonpayBody));

            ObjectNode transakBody = MAPPER.createObjectNode();
            transakBody.put("walletAddress", MOCK_C_ADDRESS);
            transakBody.put("network", "stellar");
            transakBody.put("fiatCurrency", "USD");
            transakBody.put("cryptoCurrency", "XLM");
            transakBody.put("fiatAmount", 100);
            System.out.println("Transak: " + client.createTransakUrl(transakBody));

            System.out.println("All flows completed successfully.");
        } catch (BridgeException e) {
            System.err.printf("Bridge error (%d): %s%n", e.getStatusCode(), e.getMessage());
            System.exit(1);
        } catch (Exception e) {
            System.err.println("Error: " + e.getMessage());
            System.exit(1);
        }
    }
}
