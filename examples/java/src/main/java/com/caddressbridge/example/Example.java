package com.caddressbridge.example;

import com.caddressbridge.BridgeClient;
import com.caddressbridge.BridgeException;

public final class Example {
    private static final String MOCK_C_ADDRESS =
            "CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTU";
    private static final String MOCK_G_ADDRESS =
            "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTU";
    private static final String MOCK_TOKEN_ADDRESS =
            "CATOKEN7ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMN";

    public static void main(String[] args) {
        BridgeClient client = BridgeClient.fromEnv();
        System.out.println("Bridge client ready");
        try {
            System.out.println("Health: " + client.health());
            System.out.println("Quote: " + client.getQuote("XLM", "10000000", MOCK_C_ADDRESS));
            System.out.println("Prepared: " + client.prepareFunding(
                    MOCK_G_ADDRESS, MOCK_C_ADDRESS, MOCK_TOKEN_ADDRESS, "10000000", "onboarding"));
            String funded = client.submitSignedXdr("AAAAAgAAAABexampleSignedTransactionXdr");
            System.out.println("Funded: " + funded);
            String hash = funded.replaceAll(".*\"hash\"\\s*:\\s*\"([^\"]+)\".*", "$1");
            System.out.println("Status: " + client.getStatus(hash));
            System.out.println("MoonPay: " + client.createMoonpayUrl(String.format(
                    "{\"walletAddress\":\"%s\",\"currencyCode\":\"xlm\",\"walletNetwork\":\"stellar\","
                            + "\"baseCurrencyAmount\":100,\"baseCurrencyCode\":\"USD\"}",
                    MOCK_C_ADDRESS)));
            System.out.println("Transak: " + client.createTransakUrl(String.format(
                    "{\"walletAddress\":\"%s\",\"network\":\"stellar\",\"fiatCurrency\":\"USD\","
                            + "\"cryptoCurrency\":\"XLM\",\"fiatAmount\":100}",
                    MOCK_C_ADDRESS)));
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
