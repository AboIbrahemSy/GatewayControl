package control

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"gatewaycontrol/agent/internal/state"
	"gatewaycontrol/agent/internal/types"
)

const maxResponseBytes = 6 << 20

type Client struct {
	baseURL      *url.URL
	httpClient   *http.Client
	agentVersion string
}

func New(baseURL *url.URL, longPollTimeout time.Duration, agentVersion string) *Client {
	return &Client{
		baseURL: baseURL,
		httpClient: &http.Client{
			Timeout: longPollTimeout + 15*time.Second,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return errors.New("control plane redirects are not allowed")
			},
		},
		agentVersion: agentVersion,
	}
}

func (c *Client) Enroll(ctx context.Context, token string) (state.Credentials, error) {
	if token == "" {
		return state.Credentials{}, errors.New("an enrollment token is required for initial enrollment")
	}
	var response struct {
		Agent struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"agent"`
		Credential string `json:"credential"`
	}
	err := c.request(ctx, http.MethodPost, "/api/agent/enroll", "", map[string]string{"enrollmentToken": token}, &response)
	if err != nil {
		return state.Credentials{}, err
	}
	credentials := state.Credentials{AgentID: response.Agent.ID, APICredential: response.Credential}
	if credentials.AgentID == "" || credentials.APICredential == "" {
		return state.Credentials{}, errors.New("enrollment response omitted credentials")
	}
	return credentials, nil
}

func (c *Client) Heartbeat(ctx context.Context, credentials state.Credentials, heartbeat types.Heartbeat) error {
	return c.request(ctx, http.MethodPost, "/api/agent/heartbeat", credentials.APICredential, heartbeat, nil)
}

func (c *Client) Telemetry(ctx context.Context, credentials state.Credentials, telemetry types.Telemetry) error {
	return c.request(ctx, http.MethodPost, "/api/agent/telemetry", credentials.APICredential, telemetry, nil)
}

func (c *Client) Commands(ctx context.Context, credentials state.Credentials) ([]types.Command, error) {
	var response struct {
		Commands []types.Command `json:"commands"`
	}
	if err := c.request(ctx, http.MethodGet, "/api/agent/commands", credentials.APICredential, nil, &response); err != nil {
		return nil, err
	}
	return response.Commands, nil
}

func (c *Client) SubmitResult(ctx context.Context, credentials state.Credentials, result types.CommandResult) error {
	status := "failed"
	if result.Success {
		status = "succeeded"
	}
	path := "/api/agent/commands/" + url.PathEscape(result.CommandID) + "/result"
	body := struct {
		Status string              `json:"status"`
		Result types.CommandResult `json:"result"`
	}{Status: status, Result: result}
	return c.request(ctx, http.MethodPost, path, credentials.APICredential, body, nil)
}

func (c *Client) request(ctx context.Context, method, path, credential string, requestBody, responseBody any) error {
	_, err := c.requestAllowNoContent(ctx, method, path, credential, requestBody, responseBody)
	return err
}

func (c *Client) requestAllowNoContent(ctx context.Context, method, path, credential string, requestBody, responseBody any) (bool, error) {
	var body io.Reader
	if requestBody != nil {
		encoded, err := json.Marshal(requestBody)
		if err != nil {
			return false, fmt.Errorf("encode request: %w", err)
		}
		body = bytes.NewReader(encoded)
	}
	endpoint := *c.baseURL
	parts := strings.SplitN(path, "?", 2)
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + parts[0]
	if len(parts) == 2 {
		endpoint.RawQuery = parts[1]
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint.String(), body)
	if err != nil {
		return false, fmt.Errorf("create request: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "gateway-agent/"+c.agentVersion)
	if requestBody != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if credential != "" {
		request.Header.Set("Authorization", "Bearer "+credential)
	}

	response, err := c.httpClient.Do(request)
	if err != nil {
		return false, fmt.Errorf("control request: %w", err)
	}
	defer response.Body.Close()
	limited := io.LimitReader(response.Body, maxResponseBytes+1)
	contents, err := io.ReadAll(limited)
	if err != nil {
		return false, fmt.Errorf("read control response: %w", err)
	}
	if len(contents) > maxResponseBytes {
		return false, errors.New("control response exceeded size limit")
	}
	if response.StatusCode == http.StatusNoContent {
		return true, nil
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return false, fmt.Errorf("control request returned HTTP %d", response.StatusCode)
	}
	if responseBody != nil {
		if len(contents) == 0 {
			return false, errors.New("control response body is empty")
		}
		if err := json.Unmarshal(contents, responseBody); err != nil {
			return false, fmt.Errorf("decode control response: %w", err)
		}
	}
	return false, nil
}
