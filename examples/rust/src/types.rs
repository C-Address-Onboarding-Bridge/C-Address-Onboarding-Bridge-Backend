use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct Quote {
    #[serde(rename = "estimatedFee")]
    pub estimated_fee: String,
    #[serde(rename = "expectedReceive")]
    pub expected_receive: String,
    #[serde(rename = "feeBps")]
    pub fee_bps: u32,
    pub rate: String,
}

#[derive(Debug, Deserialize)]
pub struct FundingResult {
    pub status: String,
    pub hash: String,
}

#[derive(Debug, Deserialize)]
pub struct TransactionStatus {
    pub status: String,
    pub hash: String,
}

#[derive(Debug, Deserialize)]
pub struct WidgetUrl {
    pub url: String,
}

#[derive(Debug, Serialize)]
pub struct FundPrepareBody<'a> {
    #[serde(rename = "sourceAddress")]
    pub source_address: &'a str,
    #[serde(rename = "targetAddress")]
    pub target_address: &'a str,
    #[serde(rename = "tokenAddress")]
    pub token_address: &'a str,
    pub amount: &'a str,
    pub memo: &'a str,
}

#[derive(Debug, Deserialize)]
pub struct FundPrepareResult {
    #[serde(rename = "unsignedXdr")]
    pub unsigned_xdr: String,
    pub footprint: String,
    pub fee: String,
    #[serde(rename = "sourceAddress")]
    pub source_address: String,
    #[serde(rename = "targetAddress")]
    pub target_address: String,
    #[serde(rename = "tokenAddress")]
    pub token_address: String,
    pub amount: String,
    pub memo: String,
}

#[derive(Debug, Deserialize)]
pub struct CexResult {
    pub status: String,
    #[serde(rename = "withdrawalId")]
    pub withdrawal_id: String,
    #[serde(rename = "estimatedArrival")]
    pub estimated_arrival: String,
    pub fee: String,
}
