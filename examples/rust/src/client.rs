use crate::error::BridgeError;
use crate::types::{
    CexResult, FundPrepareBody, FundPrepareResult, FundingResult, Quote, TransactionStatus, WidgetUrl,
};
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, CONTENT_TYPE};
use serde_json::{json, Value};
use std::env;
use std::time::Duration;

use uuid::Uuid;

/// Generate a fresh UUIDv4-style key for the `X-Idempotency-Key`
/// header. Non-idempotent POST endpoints (fund submission, CEX
/// withdrawal routing) de-duplicate retries server-side using this key:
/// generate one key per logical operation and pass the same key back on a
/// retry so the server does not submit the operation twice.
pub fn generate_idempotency_key() -> String {
    Uuid::new_v4().to_string()
}

pub struct BridgeClient {
    base_url: String,
    http: reqwest::Client,
    api_key: Option<String>,
}

impl BridgeClient {
    pub fn new(base_url: impl Into<String>, api_key: Option<String>) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .expect("http client"),
            api_key,
        }
    }

    pub fn from_env() -> Self {
        let base_url = env::var("BRIDGE_BASE_URL").unwrap_or_else(|_| "http://localhost:3099".into());
        let api_key = env::var("BRIDGE_API_KEY").ok();
        Self::new(base_url, api_key)
    }

    fn headers(&self) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        if let Some(key) = &self.api_key {
            if let Ok(v) = HeaderValue::from_str(key) {
                headers.insert("X-API-Key", v);
            }
        }
        headers
    }

    async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        query: &[(&str, &str)],
        body: Option<Value>,
        idempotency_key: Option<&str>,
    ) -> Result<Value, BridgeError> {
        let url = format!("{}{}", self.base_url, path);
        let mut headers = self.headers();
        if let Some(key) = idempotency_key {
            if let Ok(v) = HeaderValue::from_str(key) {
                headers.insert("X-Idempotency-Key", v);
            }
        }
        let mut req = self.http.request(method, &url).headers(headers);
        if !query.is_empty() {
            req = req.query(query);
        }
        if let Some(b) = body {
            req = req.json(&b);
        }
        let resp = req.send().await?;
        let status = resp.status().as_u16();
        let text = resp.text().await?;
        if (200..300).contains(&status) {
            Ok(serde_json::from_str(&text)?)
        } else {
            // Non-2xx bodies aren't guaranteed to be JSON (proxies/gateways may
            // return HTML or plain text) — fall back to the raw text as the
            // error message instead of letting a parse failure mask the real
            // HTTP status.
            let value: Value =
                serde_json::from_str(&text).unwrap_or_else(|_| json!({ "message": text }));
            Err(BridgeError::from_response(status, &value))
        }
    }

    pub async fn health(&self) -> Result<Value, BridgeError> {
        self.request(reqwest::Method::GET, "/health", &[], None, None).await
    }

    pub async fn get_quote(
        &self,
        source_asset: &str,
        amount: &str,
        target_address: &str,
    ) -> Result<Quote, BridgeError> {
        let value = self
            .request(
                reqwest::Method::GET,
                "/api/v1/quote",
                &[
                    ("sourceAsset", source_asset),
                    ("amount", amount),
                    ("targetAddress", target_address),
                ],
                None,
                None,
            )
            .await?;
        Ok(serde_json::from_value(value)?)
    }

    pub async fn prepare_funding(&self, body: FundPrepareBody<'_>) -> Result<FundPrepareResult, BridgeError> {
        let value = self
            .request(
                reqwest::Method::POST,
                "/api/v1/fund/prepare",
                &[],
                Some(serde_json::to_value(body)?),
                None,
            )
            .await?;
        Ok(serde_json::from_value(value)?)
    }

    pub async fn submit_signed_xdr(
        &self,
        signed_xdr: &str,
        idempotency_key: Option<String>,
    ) -> Result<FundingResult, BridgeError> {
        // #697: fund submission is non-idempotent; send a key so retries are
        // de-duplicated. Generate a fresh key per call unless the caller
        // supplies one to reuse on retry.
        let key = match idempotency_key {
            Some(k) => k,
            None => generate_idempotency_key(),
        };
        let value = self
            .request(
                reqwest::Method::POST,
                "/api/v1/fund",
                &[],
                Some(json!({ "signedXdr": signed_xdr })),
                Some(key.as_str()),
            )
            .await?;
        Ok(serde_json::from_value(value)?)
    }

    pub async fn get_status(&self, tx_hash: &str) -> Result<TransactionStatus, BridgeError> {
        let path = format!("/api/v1/status/{tx_hash}");
        let value = self.request(reqwest::Method::GET, &path, &[], None, None).await?;
        Ok(serde_json::from_value(value)?)
    }

    pub async fn create_moonpay_url(&self, body: Value) -> Result<WidgetUrl, BridgeError> {
        let value = self
            .request(reqwest::Method::POST, "/api/v1/offramp/moonpay", &[], Some(body), None)
            .await?;
        Ok(serde_json::from_value(value)?)
    }

    pub async fn create_transak_url(&self, body: Value) -> Result<WidgetUrl, BridgeError> {
        let value = self
            .request(reqwest::Method::POST, "/api/v1/offramp/transak", &[], Some(body), None)
            .await?;
        Ok(serde_json::from_value(value)?)
    }

    pub async fn route_cex_withdrawal(
        &self,
        body: Value,
        idempotency_key: Option<String>,
    ) -> Result<CexResult, BridgeError> {
        // #697: withdrawal routing is non-idempotent; send a key so a retry
        // cannot trigger a second withdrawal.
        let key = match idempotency_key {
            Some(k) => k,
            None => generate_idempotency_key(),
        };
        let value = self
            .request(
                reqwest::Method::POST,
                "/api/v1/cex/route",
                &[],
                Some(body),
                Some(key.as_str()),
            )
            .await?;
        Ok(serde_json::from_value(value)?)
    }
}
