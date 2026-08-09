package executor

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"gatewaycontrol/agent/internal/types"
)

const testConnectorID = "123e4567-e89b-12d3-a456-426614174000"
const testConnectorToken = "connector-token-that-must-remain-secret"

func TestConnectorEnableUsesTokenFileAndDeterministicContainerName(t *testing.T) {
	executor := newTestExecutor(t)
	runner := &connectorRunner{}
	executor.runner = runner
	result := executor.Execute(context.Background(), connectorCommand(true, nil))

	if !result.Success || strings.Contains(result.Stdout+result.Stderr+result.Error, testConnectorToken) {
		t.Fatalf("result = %#v", result)
	}
	for _, call := range runner.calls {
		joined := strings.Join(call.args, " ")
		if strings.Contains(joined, testConnectorToken) {
			t.Fatalf("token appeared in command args: %s", joined)
		}
	}
	create := runner.findCall("container", "create")
	if create == nil {
		t.Fatal("docker container create was not called")
	}
	joined := strings.Join(create.args, " ")
	for _, expected := range []string{
		"gateway-cloudflared-" + testConnectorID,
		"--restart unless-stopped",
		"--network gateway-control-edge",
		"type=volume,source=gateway-agent-state,target=/run/gateway-agent-state,readonly",
		"cloudflare/cloudflared:2026.7.3",
		"tunnel --no-autoupdate run --token-file /run/gateway-agent-state/connectors/" + testConnectorID + ".token",
	} {
		if !strings.Contains(joined, expected) {
			t.Fatalf("create args %q do not contain %q", joined, expected)
		}
	}
	tokenPath := filepath.Join(executor.stateDir, "connectors", testConnectorID+".token")
	contents, err := os.ReadFile(tokenPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != testConnectorToken {
		t.Fatal("persisted token does not match")
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(tokenPath)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("token permissions = %o", info.Mode().Perm())
		}
	}
}

func TestConnectorDisableRemovesContainerAndTokenIdempotently(t *testing.T) {
	executor := newTestExecutor(t)
	runner := &connectorRunner{containerExists: true}
	executor.runner = runner
	tokenPath := filepath.Join(executor.stateDir, "connectors", testConnectorID+".token")
	if err := writeTokenAtomically(tokenPath, testConnectorToken); err != nil {
		t.Fatal(err)
	}

	for attempt := 0; attempt < 2; attempt++ {
		result := executor.Execute(context.Background(), connectorCommand(false, nil))
		if !result.Success {
			t.Fatalf("attempt %d result = %#v", attempt, result)
		}
	}
	if _, err := os.Stat(tokenPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("token file error = %v, want not exist", err)
	}
	if runner.findCall("container", "rm") == nil {
		t.Fatal("existing container was not removed")
	}
}

func TestConnectorPayloadRejectsTraversalAndUnknownFields(t *testing.T) {
	executor := newTestExecutor(t)
	runner := &connectorRunner{}
	executor.runner = runner
	invalid := []json.RawMessage{
		json.RawMessage(`{"connectorId":"../../etc/passwd","name":"name","enabled":true,"token":"connector-token-that-is-long-enough"}`),
		json.RawMessage(`{"connectorId":"` + testConnectorID + `","name":"name","enabled":true,"token":"connector-token-that-is-long-enough","args":[]}`),
		json.RawMessage(`{"connectorId":"` + testConnectorID + `","name":"name","token":"connector-token-that-is-long-enough"}`),
	}
	for _, payload := range invalid {
		result := executor.Execute(context.Background(), types.Command{ID: "command", Type: "cloudflare.connector.sync", Payload: payload})
		if result.Success {
			t.Fatalf("payload unexpectedly succeeded: %s", payload)
		}
	}
	if len(runner.calls) != 0 {
		t.Fatalf("invalid payload invoked Docker: %#v", runner.calls)
	}
}

func TestConnectorFailureRedactsTokenFromDockerOutput(t *testing.T) {
	executor := newTestExecutor(t)
	runner := &connectorRunner{networkErrorOutput: testConnectorToken}
	executor.runner = runner
	result := executor.Execute(context.Background(), connectorCommand(true, nil))
	if result.Success {
		t.Fatalf("result = %#v", result)
	}
	if strings.Contains(result.Stdout+result.Stderr+result.Error, testConnectorToken) {
		t.Fatalf("token leaked in result: %#v", result)
	}
	for _, call := range runner.calls {
		if strings.Contains(strings.Join(call.args, " "), testConnectorToken) {
			t.Fatalf("token leaked in args: %#v", call.args)
		}
	}
}

func TestConnectorContainerNameIsDeterministic(t *testing.T) {
	expected := "gateway-cloudflared-123e4567-e89b-12d3-a456-426614174000"
	if actual := connectorContainerName("123E4567-E89B-12D3-A456-426614174000"); actual != expected {
		t.Fatalf("container name = %q, want %q", actual, expected)
	}
}

func connectorCommand(enabled bool, extra map[string]any) types.Command {
	payload := map[string]any{
		"connectorId": testConnectorID,
		"name":        "Main tunnel",
		"enabled":     enabled,
		"token":       testConnectorToken,
	}
	for key, value := range extra {
		payload[key] = value
	}
	encoded, _ := json.Marshal(payload)
	return types.Command{ID: "command", Type: "cloudflare.connector.sync", Payload: encoded}
}

type recordedCall struct {
	name string
	args []string
}

type connectorRunner struct {
	calls              []recordedCall
	containerExists    bool
	networkExists      bool
	networkErrorOutput string
}

func (r *connectorRunner) Run(_ context.Context, name string, args []string, _ int64) (runOutput, error) {
	r.calls = append(r.calls, recordedCall{name: name, args: append([]string(nil), args...)})
	if len(args) >= 2 && args[0] == "network" && args[1] == "inspect" {
		if r.networkErrorOutput != "" {
			return runOutput{stderr: r.networkErrorOutput, exitCode: 1}, errors.New("network inspect failed")
		}
		if !r.networkExists {
			return runOutput{stderr: "Error: No such network", exitCode: 1}, errors.New("network not found")
		}
		return runOutput{exitCode: 0}, nil
	}
	if len(args) >= 2 && args[0] == "network" && args[1] == "create" {
		r.networkExists = true
		return runOutput{stdout: "network-id", exitCode: 0}, nil
	}
	if len(args) >= 2 && args[0] == "container" && args[1] == "inspect" {
		if len(args) >= 3 && args[2] == "--format" {
			return runOutput{stdout: "true\n", exitCode: 0}, nil
		}
		if !r.containerExists {
			return runOutput{stderr: "Error: No such container", exitCode: 1}, errors.New("container not found")
		}
		return runOutput{exitCode: 0}, nil
	}
	if len(args) >= 2 && args[0] == "container" && args[1] == "rm" {
		r.containerExists = false
		return runOutput{exitCode: 0}, nil
	}
	if len(args) >= 2 && args[0] == "container" && args[1] == "create" {
		r.containerExists = true
		return runOutput{stdout: "container-id", exitCode: 0}, nil
	}
	return runOutput{exitCode: 0}, nil
}

func (r *connectorRunner) LookPath(string) (string, error) {
	return "/usr/bin/docker", nil
}

func (r *connectorRunner) findCall(parts ...string) *recordedCall {
	for index := range r.calls {
		if len(r.calls[index].args) < len(parts) {
			continue
		}
		matches := true
		for partIndex := range parts {
			if r.calls[index].args[partIndex] != parts[partIndex] {
				matches = false
				break
			}
		}
		if matches {
			return &r.calls[index]
		}
	}
	return nil
}
