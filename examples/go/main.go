package main

import (
	"fmt"
	"os"

	"github.com/c-address-onboarding-bridge/examples/go/caddressbridge"
)

const (
	mockCAddress    = "CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTU"
	mockGAddress    = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTU"
	mockTokenAddr   = "CATOKEN7ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMN"
)

func main() {
	client := caddressbridge.NewClientFromEnv()
	fmt.Println("Bridge client ready")

	if err := run(client); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("All flows completed successfully.")
}

func run(client *caddressbridge.BridgeClient) error {
	health, err := client.Health()
	if err != nil {
		return err
	}
	fmt.Printf("Health: %v\n", health["status"])

	quote, err := client.GetQuote("XLM", "10000000", mockCAddress)
	if err != nil {
		return err
	}
	fmt.Printf("Quote fee: %v stroops, receive: %v\n", quote["estimatedFee"], quote["expectedReceive"])

	prepared, err := client.PrepareFunding(mockGAddress, mockCAddress, mockTokenAddr, "10000000", "onboarding")
	if err != nil {
		return err
	}
	fmt.Printf("Funding prepared: %v\n", prepared["instruction"])

	funded, err := client.SubmitSignedXDR("AAAAAgAAAABexampleSignedTransactionXdr")
	if err != nil {
		return err
	}
	fmt.Printf("Fund submitted: %v hash=%v\n", funded["status"], funded["hash"])

	status, err := client.GetStatus(funded["hash"].(string))
	if err != nil {
		return err
	}
	fmt.Printf("Transaction status: %v\n", status["status"])

	moonpay, err := client.CreateMoonpayURL(map[string]any{
		"walletAddress":      mockCAddress,
		"currencyCode":       "xlm",
		"walletNetwork":      "stellar",
		"baseCurrencyAmount": 100,
		"baseCurrencyCode":   "USD",
	})
	if err != nil {
		return err
	}
	fmt.Printf("MoonPay URL: %v\n", moonpay["url"])

	transak, err := client.CreateTransakURL(map[string]any{
		"walletAddress":  mockCAddress,
		"network":        "stellar",
		"fiatCurrency":   "USD",
		"cryptoCurrency": "XLM",
		"fiatAmount":     100,
	})
	if err != nil {
		return err
	}
	fmt.Printf("Transak URL: %v\n", transak["url"])
	return nil
}
