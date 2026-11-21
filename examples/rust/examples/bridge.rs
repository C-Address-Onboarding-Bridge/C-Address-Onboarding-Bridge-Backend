use c_address_bridge::{BridgeClient, BridgeError};
use c_address_bridge::types::FundPrepareBody;
use serde_json::json;

const MOCK_C_ADDRESS: &str = "CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTU";
const MOCK_G_ADDRESS: &str = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTU";
const MOCK_TOKEN_ADDRESS: &str = "CATOKEN7ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMN";

#[tokio::main]
async fn main() -> Result<(), BridgeError> {
    let client = BridgeClient::from_env();
    println!("Bridge client ready");

    let health = client.health().await?;
    println!("Health: {}", health["status"]);

    let quote = client.get_quote("XLM", "10000000", MOCK_C_ADDRESS).await?;
    println!(
        "Quote fee: {} stroops, receive: {}",
        quote.estimated_fee, quote.expected_receive
    );

    let prepared = client
        .prepare_funding(FundPrepareBody {
            source_address: MOCK_G_ADDRESS,
            target_address: MOCK_C_ADDRESS,
            token_address: MOCK_TOKEN_ADDRESS,
            amount: "10000000",
            memo: "onboarding",
        })
        .await?;
    println!("Funding prepared: unsignedXdr={}...", &prepared.unsigned_xdr[..prepared.unsigned_xdr.len().min(40)]);

    // In production, sign prepared.unsigned_xdr with the source key using stellar-base.
    // For this example against the mock server we re-use the unsigned XDR directly
    // (the mock validates only that the submitted value starts with 'AAAA').
    let funded = client
        .submit_signed_xdr(&prepared.unsigned_xdr)
        .await?;
    println!(
        "Fund submitted: {} hash={}...",
        funded.status,
        &funded.hash[..funded.hash.len().min(16)]
    );

    let status = client.get_status(&funded.hash).await?;
    println!("Transaction status: {}", status.status);

    let moonpay = client
        .create_moonpay_url(json!({
            "walletAddress": MOCK_C_ADDRESS,
            "currencyCode": "xlm",
            "walletNetwork": "stellar",
            "baseCurrencyAmount": 100,
            "baseCurrencyCode": "USD"
        }))
        .await?;
    println!("MoonPay URL: {}...", &moonpay.url[..moonpay.url.len().min(60)]);

    let transak = client
        .create_transak_url(json!({
            "walletAddress": MOCK_C_ADDRESS,
            "network": "stellar",
            "fiatCurrency": "USD",
            "cryptoCurrency": "XLM",
            "fiatAmount": 100
        }))
        .await?;
    println!("Transak URL: {}...", &transak.url[..transak.url.len().min(60)]);

    let cex = client
        .route_cex_withdrawal(json!({
            "exchange": "coinbase",
            "sourceAsset": "XLM",
            "amount": "10000000",
            "targetCAddress": MOCK_C_ADDRESS,
            "targetNetwork": "stellar"
        }))
        .await?;
    println!("CEX withdrawal: status={} id={}", cex.status, cex.withdrawal_id);

    println!("All flows completed successfully.");
    Ok(())
}
