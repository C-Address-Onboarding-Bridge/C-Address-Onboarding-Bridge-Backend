package caddressbridge

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

type BridgeClient struct {
	BaseURL string
	APIKey  string
	HTTP    *http.Client
}

type BridgeError struct {
	Status  int
	Message string
	Code    string
}

func (e *BridgeError) Error() string {
	return fmt.Sprintf("bridge error (%d): %s", e.Status, e.Message)
}

func NewClient(baseURL, apiKey string) *BridgeClient {
	return &BridgeClient{
		BaseURL: strings.TrimRight(baseURL, "/"),
		APIKey:  apiKey,
		HTTP:    &http.Client{Timeout: 30 * time.Second},
	}
}

func NewClientFromEnv() *BridgeClient {
	baseURL := os.Getenv("BRIDGE_BASE_URL")
	if baseURL == "" {
		baseURL = "http://localhost:3099"
	}
	return NewClient(baseURL, os.Getenv("BRIDGE_API_KEY"))
}

// GenerateIdempotencyKey returns a fresh UUIDv4-style key for the
// X-Idempotency-Key header. Non-idempotent POST endpoints (fund
// submission, CEX withdrawal routing) de-duplicate retries server-side
// using this key: generate one key per logical operation and pass the
// same key back on a retry so the server does not submit twice.
func GenerateIdempotencyKey() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		// Fall back to a 128-bit value derived from the timestamp. This is
		// not cryptographic but still yields a valid UUIDv4-shaped key.
		for i := range b {
			b[i] = byte(time.Now().UnixNano() >> (i % 8))
		}
	}
	// Set the version and variant bits so the key is a well-formed v4 UUID.
	b[8] = (b[8] & 0x0f) | 0x40
	b[9] = (b[9] & 0x3f) | 0x80
	return fmt.Sprintf(
		"%s-%s-%s-%s-%s",
		hex.EncodeToString(b[0:4]),
		hex.EncodeToString(b[4:6]),
		hex.EncodeToString(b[6:8]),
		hex.EncodeToString(b[8:10]),
		hex.EncodeToString(b[10:16]),
	)
}

func (c *BridgeClient) request(method, path, idempotencyKey string, query url.Values, body any) (map[string]any, error) {
	u := c.BaseURL + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, u, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if c.APIKey != "" {
		req.Header.Set("X-API-Key", c.APIKey)
	}
	if idempotencyKey != "" {
		req.Header.Set("X-Idempotency-Key", idempotencyKey)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, &BridgeError{Status: 0, Message: err.Error()}
	}
	defer resp.Body.Close()
	payload, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if len(payload) > 0 {
		if err := json.Unmarshal(payload, &out); err != nil {
			return nil, err
		}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		msg, _ := out["message"].(string)
		if msg == "" {
			msg = resp.Status
		}
		code, _ := out["code"].(string)
		return nil, &BridgeError{Status: resp.StatusCode, Message: msg, Code: code}
	}
	return out, nil
}

func (c *BridgeClient) Health() (map[string]any, error) {
	return c.request(http.MethodGet, "/health", "", nil, nil)
}

func (c *BridgeClient) GetQuote(sourceAsset, amount, targetAddress string) (map[string]any, error) {
	q := url.Values{}
	q.Set("sourceAsset", sourceAsset)
	q.Set("amount", amount)
	q.Set("targetAddress", targetAddress)
	return c.request(http.MethodGet, "/api/v1/quote", "", q, nil)
}

func (c *BridgeClient) PrepareFunding(source, target, token, amount, memo string) (map[string]any, error) {
	return c.request(http.MethodPost, "/api/v1/fund/prepare", "", nil, map[string]string{
		"sourceAddress": source,
		"targetAddress": target,
		"tokenAddress":  token,
		"amount":        amount,
		"memo":          memo,
	})
}

func (c *BridgeClient) SubmitSignedXDR(signedXdr string) (map[string]any, error) {
	return c.request(
		http.MethodPost,
		"/api/v1/fund",
		GenerateIdempotencyKey(), // #697: de-duplicate retried submissions
		nil,
		map[string]string{"signedXdr": signedXdr},
	)
}

func (c *BridgeClient) GetStatus(txHash string) (map[string]any, error) {
	return c.request(http.MethodGet, "/api/v1/status/"+txHash, "", nil, nil)
}

func (c *BridgeClient) CreateMoonpayURL(body map[string]any) (map[string]any, error) {
	return c.request(http.MethodPost, "/api/v1/offramp/moonpay", "", nil, body)
}

func (c *BridgeClient) CreateTransakURL(body map[string]any) (map[string]any, error) {
	return c.request(http.MethodPost, "/api/v1/offramp/transak", "", nil, body)
}

func (c *BridgeClient) RouteCexWithdrawal(body map[string]any) (map[string]any, error) {
	return c.request(
		http.MethodPost,
		"/api/v1/cex/route",
		GenerateIdempotencyKey(), // #697: de-duplicate retried withdrawals
		nil,
		body,
	)
}
