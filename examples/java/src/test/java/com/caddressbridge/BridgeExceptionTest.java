package com.caddressbridge;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class BridgeExceptionTest {

    @Test
    void extractsMessageFromJsonBody() {
        BridgeException ex = BridgeException.fromResponse(401, "{\"message\":\"Unauthorized\",\"code\":\"AUTH\"}");
        assertEquals(401, ex.getStatusCode());
        assertEquals("Unauthorized", ex.getMessage());
    }

    @Test
    void extractsMessageWhenOtherFieldsPrecedeIt() {
        BridgeException ex = BridgeException.fromResponse(400, "{\"code\":\"VALIDATION\",\"message\":\"amount is required\",\"fields\":[]}");
        assertEquals(400, ex.getStatusCode());
        assertEquals("amount is required", ex.getMessage());
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
