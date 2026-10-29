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
        String code = null;
        if (body != null && body.contains("\"error\"")) {
            int start = body.indexOf("\"error\"");
            int colon = body.indexOf(':', start);
            int quoteStart = body.indexOf('"', colon + 1);
            int quoteEnd = body.indexOf('"', quoteStart + 1);
            if (quoteStart > 0 && quoteEnd > quoteStart) {
                code = body.substring(quoteStart + 1, quoteEnd);
            }
        }
        String message = code;
        if (body != null && body.contains("\"message\"")) {
            int start = body.indexOf("\"message\"");
            int colon = body.indexOf(':', start);
            int quoteStart = body.indexOf('"', colon + 1);
            int quoteEnd = body.indexOf('"', quoteStart + 1);
            if (quoteStart > 0 && quoteEnd > quoteStart) {
                message = body.substring(quoteStart + 1, quoteEnd);
            }
        }
        if (message == null) {
            message = body != null ? body : "Request failed";
        }
        return new BridgeException(status, message);
    }
}
