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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn maps_401_and_403_to_auth() {
        for status in [401u16, 403u16] {
            let err = BridgeError::from_response(status, &json!({ "message": "nope" }));
            match err {
                BridgeError::Auth { status: s, message } => {
                    assert_eq!(s, status);
                    assert_eq!(message, "nope");
                }
                other => panic!("expected Auth, got {other:?}"),
            }
        }
    }

    #[test]
    fn maps_400_and_422_to_validation() {
        for status in [400u16, 422u16] {
            let err = BridgeError::from_response(status, &json!({ "message": "bad input" }));
            match err {
                BridgeError::Validation { status: s, message } => {
                    assert_eq!(s, status);
                    assert_eq!(message, "bad input");
                }
                other => panic!("expected Validation, got {other:?}"),
            }
        }
    }

    #[test]
    fn maps_404_to_not_found() {
        let err = BridgeError::from_response(404, &json!({ "message": "missing" }));
        assert!(matches!(err, BridgeError::NotFound { message } if message == "missing"));
    }

    #[test]
    fn maps_429_to_rate_limit() {
        let err = BridgeError::from_response(429, &json!({ "message": "slow down" }));
        assert!(matches!(err, BridgeError::RateLimit { message } if message == "slow down"));
    }

    #[test]
    fn maps_5xx_to_server() {
        for status in [500u16, 502u16, 599u16] {
            let err = BridgeError::from_response(status, &json!({ "message": "boom" }));
            match err {
                BridgeError::Server { status: s, message } => {
                    assert_eq!(s, status);
                    assert_eq!(message, "boom");
                }
                other => panic!("expected Server, got {other:?}"),
            }
        }
    }

    #[test]
    fn maps_unknown_status_to_other() {
        let err = BridgeError::from_response(418, &json!({ "message": "teapot" }));
        match err {
            BridgeError::Other { status, message } => {
                assert_eq!(status, 418);
                assert_eq!(message, "teapot");
            }
            other => panic!("expected Other, got {other:?}"),
        }
    }

    #[test]
    fn falls_back_to_default_message_when_missing() {
        let err = BridgeError::from_response(500, &json!({}));
        assert!(matches!(err, BridgeError::Server { message, .. } if message == "request failed"));
    }

    #[test]
    fn falls_back_to_default_message_when_body_is_not_an_object() {
        let err = BridgeError::from_response(502, &json!("<html>Bad Gateway</html>"));
        assert!(matches!(err, BridgeError::Server { message, .. } if message == "request failed"));
    }
}
