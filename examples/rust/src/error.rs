use thiserror::Error;

#[derive(Debug, Error)]
pub enum BridgeError {
    #[error("auth error ({status}): {message}")]
    Auth { status: u16, message: String },
    #[error("validation error ({status}): {message}")]
    Validation { status: u16, message: String },
    #[error("not found: {message}")]
    NotFound { message: String },
    #[error("rate limited: {message}")]
    RateLimit { message: String },
    #[error("server error ({status}): {message}")]
    Server { status: u16, message: String },
    #[error("network error: {0}")]
    Network(#[from] reqwest::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("bridge error ({status}): {message}")]
    Other { status: u16, message: String },
}

impl BridgeError {
    pub fn from_response(status: u16, body: &serde_json::Value) -> Self {
        let message = body
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("request failed")
            .to_string();
        match status {
            401 | 403 => Self::Auth { status, message },
            400 | 422 => Self::Validation { status, message },
            404 => Self::NotFound { message },
            429 => Self::RateLimit { message },
            500..=599 => Self::Server { status, message },
            _ => Self::Other { status, message },
        }
    }
}
