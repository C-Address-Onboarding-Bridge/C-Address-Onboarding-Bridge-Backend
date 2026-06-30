package com.caddressbridge;

public final class BridgeException extends Exception {
    private final int statusCode;

    public BridgeException(int statusCode, String message) {
        super(message);
        this.statusCode = statusCode;
    }

    public int getStatusCode() {
        return statusCode;
    }

    public static BridgeException fromResponse(int status, String body) {
        String message = body;
        if (body != null && body.contains("\"message\"")) {
            int start = body.indexOf("\"message\"");
            int colon = body.indexOf(':', start);
            int quoteStart = body.indexOf('"', colon + 1);
            int quoteEnd = body.indexOf('"', quoteStart + 1);
            if (quoteStart > 0 && quoteEnd > quoteStart) {
                message = body.substring(quoteStart + 1, quoteEnd);
            }
        }
        return new BridgeException(status, message);
    }
}
