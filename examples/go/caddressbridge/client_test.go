package caddressbridge

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func newTestClient(handler http.HandlerFunc) (*BridgeClient, func()) {
	srv := httptest.NewServer(handler)
	c := NewClient(srv.URL, "")
	return c, srv.Close
}

func jsonHandler(status int, body map[string]any) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(body)
	}
}

func TestRequest_SuccessReturnsBody(t *testing.T) {
	client, closeSrv := newTestClient(jsonHandler(http.StatusOK, map[string]any{"status": "ok"}))
	defer closeSrv()

	out, err := client.Health()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out["status"] != "ok" {
		t.Fatalf("expected status ok, got %v", out["status"])
	}
}

func TestRequest_MapsAuthErrors(t *testing.T) {
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden} {
		// Real API shape: {"error": "invalid_api_key"}
		client, closeSrv := newTestClient(jsonHandler(status, map[string]any{"error": "invalid_api_key"}))

		_, err := client.Health()
		closeSrv()

		var bErr *BridgeError
		if !errors.As(err, &bErr) {
			t.Fatalf("status %d: expected *BridgeError, got %T (%v)", status, err, err)
		}
		if bErr.Status != status {
			t.Fatalf("expected status %d, got %d", status, bErr.Status)
		}
		if bErr.Message != "invalid_api_key" {
			t.Fatalf("expected message 'invalid_api_key', got %q", bErr.Message)
		}
		if bErr.Code != "invalid_api_key" {
			t.Fatalf("expected code 'invalid_api_key', got %q", bErr.Code)
		}
	}
}

func TestRequest_MapsValidationErrors(t *testing.T) {
	for _, status := range []int{http.StatusBadRequest, http.StatusUnprocessableEntity} {
		// Real API shape: {"error": "validation_error", "details": [...]}
		client, closeSrv := newTestClient(jsonHandler(status, map[string]any{"error": "validation_error", "details": []any{}}))

		_, err := client.Health()
		closeSrv()

		var bErr *BridgeError
		if !errors.As(err, &bErr) {
			t.Fatalf("status %d: expected *BridgeError, got %T (%v)", status, err, err)
		}
		if bErr.Status != status {
			t.Fatalf("expected status %d, got %d", status, bErr.Status)
		}
		if bErr.Message != "validation_error" {
			t.Fatalf("expected message 'validation_error', got %q", bErr.Message)
		}
	}
}

func TestRequest_MapsNotFound(t *testing.T) {
	client, closeSrv := newTestClient(jsonHandler(http.StatusNotFound, map[string]any{"error": "not_found"}))
	defer closeSrv()

	_, err := client.Health()

	var bErr *BridgeError
	if !errors.As(err, &bErr) {
		t.Fatalf("expected *BridgeError, got %T (%v)", err, err)
	}
	if bErr.Status != http.StatusNotFound {
		t.Fatalf("expected status 404, got %d", bErr.Status)
	}
}

func TestRequest_MapsRateLimit(t *testing.T) {
	// Real API shape: {"error": "rate_limit_exceeded"}
	client, closeSrv := newTestClient(jsonHandler(http.StatusTooManyRequests, map[string]any{"error": "rate_limit_exceeded"}))
	defer closeSrv()

	_, err := client.Health()

	var bErr *BridgeError
	if !errors.As(err, &bErr) {
		t.Fatalf("expected *BridgeError, got %T (%v)", err, err)
	}
	if bErr.Status != http.StatusTooManyRequests {
		t.Fatalf("expected status 429, got %d", bErr.Status)
	}
}

func TestRequest_MapsServerErrors(t *testing.T) {
	// Real API shape: {"error": "internal_server_error"}
	client, closeSrv := newTestClient(jsonHandler(http.StatusInternalServerError, map[string]any{"error": "internal_server_error"}))
	defer closeSrv()

	_, err := client.Health()

	var bErr *BridgeError
	if !errors.As(err, &bErr) {
		t.Fatalf("expected *BridgeError, got %T (%v)", err, err)
	}
	if bErr.Status != http.StatusInternalServerError {
		t.Fatalf("expected status 500, got %d", bErr.Status)
	}
	if bErr.Code != "internal_server_error" {
		t.Fatalf("expected code 'internal_server_error', got %q", bErr.Code)
	}
}

func TestRequest_FallsBackToStatusTextWhenMessageMissing(t *testing.T) {
	client, closeSrv := newTestClient(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]any{})
	})
	defer closeSrv()

	_, err := client.Health()

	var bErr *BridgeError
	if !errors.As(err, &bErr) {
		t.Fatalf("expected *BridgeError, got %T (%v)", err, err)
	}
	// When "error" field is absent, falls back to HTTP status text (e.g. "502 Bad Gateway")
	if bErr.Status != http.StatusBadGateway {
		t.Fatalf("expected status 502, got %d", bErr.Status)
	}
	if bErr.Message == "" {
		t.Fatalf("expected non-empty fallback message, got empty string")
	}
}

func TestRequest_BuildsQueryParams(t *testing.T) {
	var gotQuery string
	client, closeSrv := newTestClient(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{"estimatedFee": "1", "expectedReceive": "2", "feeBps": 30, "rate": "1.0"})
	})
	defer closeSrv()

	_, err := client.GetQuote("XLM", "1000", "CTARGET")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotQuery == "" {
		t.Fatalf("expected query string to be set")
	}
}

func TestErrorMessage(t *testing.T) {
	err := &BridgeError{Status: 404, Message: "missing"}
	if err.Error() != "bridge error (404): missing" {
		t.Fatalf("unexpected Error() output: %q", err.Error())
	}
}
