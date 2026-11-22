package com.caddressbridge;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class BridgeExceptionTest {

    @Test
    void extractsMessageFromJsonBody() {
        // Real API shape: {"error": "invalid_api_key"}
        BridgeException ex = BridgeException.fromResponse(401, "{\"error\":\"invalid_api_key\"}");
        assertEquals(401, ex.getStatusCode());
        assertEquals("invalid_api_key", ex.getMessage());
    }

    @Test
    void extractsMessageWhenOtherFieldsPrecedeIt() {
        // Real API shape: {"error": "validation_error", "details": [...]}
        BridgeException ex = BridgeException.fromResponse(400, "{\"error\":\"validation_error\",\"details\":[]}");
        assertEquals(400, ex.getStatusCode());
        assertEquals("validation_error", ex.getMessage());
    }

    @Test
    void fallsBackToRawBodyWhenNoMessageField() {
        BridgeException ex = BridgeException.fromResponse(502, "<html>Bad Gateway</html>");
        assertEquals(502, ex.getStatusCode());
        assertEquals("<html>Bad Gateway</html>", ex.getMessage());
    }

    @Test
    void fallsBackToRawBodyForPlainText() {
        BridgeException ex = BridgeException.fromResponse(500, "internal server error");
        assertEquals(500, ex.getStatusCode());
        assertEquals("internal server error", ex.getMessage());
    }

    @Test
    void handlesNullBody() {
        BridgeException ex = BridgeException.fromResponse(404, null);
        assertEquals(404, ex.getStatusCode());
        assertEquals(null, ex.getMessage());
    }

    @Test
    void handlesEmptyBody() {
        BridgeException ex = BridgeException.fromResponse(404, "");
        assertEquals(404, ex.getStatusCode());
        assertEquals("", ex.getMessage());
    }
}
