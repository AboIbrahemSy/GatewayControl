package control

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"gatewaycontrol/agent/internal/state"
	"gatewaycontrol/agent/internal/types"
)

const testCredential = "raw-credential-with-at-least-thirty-two-characters"

func TestEnrollMatchesServerContract(t *testing.T) {
	token := "enrollment-token-with-at-least-32-characters"
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/agent/enroll" || request.Method != http.MethodPost {
			t.Errorf("unexpected request: %s %s", request.Method, request.URL.Path)
		}
		if request.Header.Get("Authorization") != "" {
			t.Error("enrollment must not send bearer authorization")
		}
		var body map[string]string
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if len(body) != 1 || body["enrollmentToken"] != token {
			t.Errorf("body = %#v", body)
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"agent":{"id":"123e4567-e89b-12d3-a456-426614174000","name":"edge-1"},"credential":"` + testCredential + `"}`))
	}))
	defer server.Close()

	client := New(mustURL(t, server.URL), time.Second, "test")
	credentials, err := client.Enroll(context.Background(), token)
	if err != nil {
		t.Fatal(err)
	}
	expected := state.Credentials{AgentID: "123e4567-e89b-12d3-a456-426614174000", APICredential: testCredential}
	if credentials != expected {
		t.Fatalf("credentials = %#v, want %#v", credentials, expected)
	}
}

func TestHeartbeatMatchesServerContractWithoutAgentIDInPath(t *testing.T) {
	heartbeat := types.Heartbeat{Hostname: "host-1", OS: "linux", Architecture: "amd64", AgentVersion: "1.2.3"}
	server := authenticatedServer(t, http.MethodPost, "/api/agent/heartbeat", func(response http.ResponseWriter, request *http.Request) {
		var actual types.Heartbeat
		if err := json.NewDecoder(request.Body).Decode(&actual); err != nil {
			t.Error(err)
		}
		if actual != heartbeat {
			t.Errorf("heartbeat = %#v, want %#v", actual, heartbeat)
		}
		_, _ = response.Write([]byte(`{"accepted":true}`))
	})
	defer server.Close()

	client := New(mustURL(t, server.URL), time.Second, "test")
	if err := client.Heartbeat(context.Background(), testCredentials(), heartbeat); err != nil {
		t.Fatal(err)
	}
}

func TestCommandsDecodesServerBatch(t *testing.T) {
	server := authenticatedServer(t, http.MethodGet, "/api/agent/commands", func(response http.ResponseWriter, request *http.Request) {
		if request.URL.RawQuery != "" {
			t.Errorf("unexpected query = %q", request.URL.RawQuery)
		}
		_, _ = response.Write([]byte(`{"commands":[{"id":"123e4567-e89b-12d3-a456-426614174000","type":"ping","payload":{}},{"id":"223e4567-e89b-12d3-a456-426614174001","type":"docker.info","payload":{}}]}`))
	})
	defer server.Close()

	client := New(mustURL(t, server.URL), time.Second, "test")
	commands, err := client.Commands(context.Background(), testCredentials())
	if err != nil {
		t.Fatal(err)
	}
	if len(commands) != 2 || commands[0].Type != "ping" || commands[1].Type != "docker.info" {
		t.Fatalf("commands = %#v", commands)
	}
}

func TestSubmitResultMatchesServerEnvelope(t *testing.T) {
	commandID := "123e4567-e89b-12d3-a456-426614174000"
	startedAt := time.Date(2026, time.August, 8, 12, 0, 0, 0, time.UTC)
	result := types.CommandResult{
		CommandID: commandID, Type: "ping", Success: true, ExitCode: 0, Stdout: "pong",
		TimedOut: false, Truncated: false, StartedAt: startedAt, FinishedAt: startedAt.Add(time.Millisecond),
	}
	server := authenticatedServer(t, http.MethodPost, "/api/agent/commands/"+commandID+"/result", func(response http.ResponseWriter, request *http.Request) {
		var body struct {
			Status string              `json:"status"`
			Result types.CommandResult `json:"result"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body.Status != "succeeded" || body.Result != result {
			t.Errorf("body = %#v", body)
		}
		_, _ = response.Write([]byte(`{"accepted":true,"idempotent":false}`))
	})
	defer server.Close()

	client := New(mustURL(t, server.URL), time.Second, "test")
	if err := client.SubmitResult(context.Background(), testCredentials(), result); err != nil {
		t.Fatal(err)
	}
}

func TestSubmitResultMapsFailureStatus(t *testing.T) {
	commandID := "123e4567-e89b-12d3-a456-426614174000"
	server := authenticatedServer(t, http.MethodPost, "/api/agent/commands/"+commandID+"/result", func(response http.ResponseWriter, request *http.Request) {
		var body struct {
			Status string `json:"status"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body.Status != "failed" {
			t.Errorf("status = %q", body.Status)
		}
		_, _ = response.Write([]byte(`{"accepted":true}`))
	})
	defer server.Close()

	client := New(mustURL(t, server.URL), time.Second, "test")
	if err := client.SubmitResult(context.Background(), testCredentials(), types.CommandResult{CommandID: commandID}); err != nil {
		t.Fatal(err)
	}
}

func TestClientDoesNotExposeErrorResponseBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		http.Error(response, "sensitive server detail", http.StatusUnauthorized)
	}))
	defer server.Close()

	client := New(mustURL(t, server.URL), time.Second, "test")
	_, err := client.Enroll(context.Background(), "enrollment-token-with-at-least-32-characters")
	if err == nil || err.Error() != "control request returned HTTP 401" {
		t.Fatalf("error = %v", err)
	}
}

func authenticatedServer(t *testing.T, method, path string, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != method || request.URL.Path != path {
			t.Errorf("unexpected request: %s %s", request.Method, request.URL.Path)
		}
		if request.Header.Get("Authorization") != "Bearer "+testCredential {
			t.Errorf("Authorization = %q", request.Header.Get("Authorization"))
		}
		handler(response, request)
	}))
}

func testCredentials() state.Credentials {
	return state.Credentials{AgentID: "not-sent-in-url", APICredential: testCredential}
}

func mustURL(t *testing.T, value string) *url.URL {
	t.Helper()
	parsed, err := url.Parse(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}
