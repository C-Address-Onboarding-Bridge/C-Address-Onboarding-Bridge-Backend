package main

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// newIdempotencyKey returns a random UUIDv4 string suitable for the
// Idempotency-Key header. Reuse the same key when retrying the same
// logical request so the API can de-duplicate it.
func newIdempotencyKey() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

// postJSON sends body to path with an Idempotency-Key header. The key is
// generated once per logical request and reused across retries.
type Client struct {
	BaseURL string
	APIKey  string
	HTTP    *http.Client
}

func (c *Client) postJSON(path string, body interface{}) ([]byte, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	idempotencyKey, err := newIdempotencyKey()
	if err != nil {
		return nil, err
	}

	httpClient := c.HTTP
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}

	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		req, err := http.NewRequest(http.MethodPost, c.BaseURL+path, bytes.NewReader(payload))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Idempotency-Key", idempotencyKey)
		if c.APIKey != "" {
			req.Header.Set("Authorization", "Bearer "+c.APIKey)
		}

		resp, err := httpClient.Do(req)
		if err != nil {
			lastErr = err
			time.Sleep(time.Duration(attempt+1) * 500 * time.Millisecond)
			continue
		}
		defer resp.Body.Close()

		respBody, err := io.ReadAll(resp.Body)
		if err != nil {
			return nil, err
		}
		if resp.StatusCode >= 500 {
			lastErr = fmt.Errorf("server error %d: %s", resp.StatusCode, string(respBody))
			time.Sleep(time.Duration(attempt+1) * 500 * time.Millisecond)
			continue
		}
		if resp.StatusCode >= 400 {
			return nil, fmt.Errorf("request failed %d: %s", resp.StatusCode, string(respBody))
		}
		return respBody, nil
	}
	return nil, lastErr
}

// Fund submits a funding request to /api/v1/fund.
func (c *Client) Fund(req map[string]interface{}) ([]byte, error) {
	return c.postJSON("/api/v1/fund", req)
}

// CexRoute submits a CEX routing request to /api/v1/cex/route.
func (c *Client) CexRoute(req map[string]interface{}) ([]byte, error) {
	return c.postJSON("/api/v1/cex/route", req)
}
