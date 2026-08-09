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

const testStackID = "323e4567-e89b-12d3-a456-426614174002"

func TestStackSyncUsesHostPathsAndStoresDefinition(t *testing.T) {
	executor := newTestExecutor(t)
	runner := &scriptedRunner{responses: []scriptedResponse{{}, {}}}
	executor.runner = runner
	composeYAML := "services:\n  web:\n    image: nginx:1.29\n"
	result := executor.Execute(context.Background(), stackCommand(true, composeYAML, nil))
	if !result.Success || result.Stdout != "compose stack synchronized" {
		t.Fatalf("result = %#v", result)
	}
	if len(runner.calls) != 2 {
		t.Fatalf("calls = %#v", runner.calls)
	}
	hostFile := filepath.Join(executor.hostStacksRoot, testStackID, "compose.yaml")
	for _, call := range runner.calls {
		joined := strings.Join(call.args, " ")
		if !strings.Contains(joined, "--file "+hostFile) {
			t.Fatalf("Docker call does not use host compose path: %s", joined)
		}
		if strings.Contains(joined, executor.stacksRoot) && executor.stacksRoot != executor.hostStacksRoot {
			t.Fatalf("Docker call contains container stacks root: %s", joined)
		}
	}
	storedPath := filepath.Join(executor.stacksRoot, testStackID, "compose.yaml")
	contents, err := os.ReadFile(storedPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != composeYAML {
		t.Fatalf("stored compose definition = %q", contents)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(storedPath)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("compose permissions = %o", info.Mode().Perm())
		}
	}
}

func TestStackSyncRollsBackWithoutReturningSecrets(t *testing.T) {
	executor := newTestExecutor(t)
	directory, err := secureSubdirectory(executor.stacksRoot, testStackID)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, "compose.yaml")
	oldDefinition := []byte("services:\n  old:\n    image: nginx:1.28\n")
	if err := writeFileAtomically(path, oldDefinition, 0o600); err != nil {
		t.Fatal(err)
	}
	secret := "database-password-must-not-leak"
	runner := &scriptedRunner{responses: []scriptedResponse{
		{},
		{output: runOutput{stderr: secret, exitCode: 1}, err: errors.New("compose up failed: " + secret)},
		{},
	}}
	executor.runner = runner
	newDefinition := "services:\n  app:\n    environment:\n      PASSWORD: " + secret + "\n"
	result := executor.Execute(context.Background(), stackCommand(true, newDefinition, nil))
	if result.Success || strings.Contains(result.Stdout+result.Stderr+result.Error, secret) {
		t.Fatalf("result = %#v", result)
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != string(oldDefinition) {
		t.Fatalf("definition was not rolled back: %q", contents)
	}
	if len(runner.calls) != 3 || !strings.Contains(strings.Join(runner.calls[2].args, " "), "up --detach --remove-orphans") {
		t.Fatalf("old running configuration was not reapplied: %#v", runner.calls)
	}
}

func TestStackSyncValidationFailureRestoresLastKnownGoodWithoutRestart(t *testing.T) {
	executor := newTestExecutor(t)
	directory, err := secureSubdirectory(executor.stacksRoot, testStackID)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, "compose.yaml")
	oldDefinition := []byte("services:\n  old:\n    image: nginx:1.28\n")
	if err := writeFileAtomically(path, oldDefinition, 0o600); err != nil {
		t.Fatal(err)
	}
	runner := &scriptedRunner{responses: []scriptedResponse{{output: runOutput{exitCode: 1}, err: errors.New("invalid compose")}}}
	executor.runner = runner
	result := executor.Execute(context.Background(), stackCommand(true, "services: invalid", nil))
	if result.Success || len(runner.calls) != 1 {
		t.Fatalf("result = %#v calls = %#v", result, runner.calls)
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != string(oldDefinition) {
		t.Fatalf("definition was not restored: %q", contents)
	}
}

func TestStackSyncDisabledStopsAndRetainsDefinition(t *testing.T) {
	executor := newTestExecutor(t)
	runner := &scriptedRunner{responses: []scriptedResponse{{}, {}}}
	executor.runner = runner
	definition := "services:\n  web:\n    image: nginx:1.29\n"
	result := executor.Execute(context.Background(), stackCommand(false, definition, nil))
	if !result.Success || len(runner.calls) != 2 || runner.calls[1].args[len(runner.calls[1].args)-1] != "stop" {
		t.Fatalf("result = %#v calls = %#v", result, runner.calls)
	}
	if _, err := os.Stat(filepath.Join(executor.stacksRoot, testStackID, "compose.yaml")); err != nil {
		t.Fatal(err)
	}
}

func TestStackSyncRejectsTraversalUnknownFieldsAndOversizePayload(t *testing.T) {
	executor := newTestExecutor(t)
	runner := &scriptedRunner{}
	executor.runner = runner
	invalid := []types.Command{
		stackCommand(true, "services: {}", map[string]any{"stackId": "../../etc"}),
		stackCommand(true, "services: {}", map[string]any{"unknown": true}),
		{ID: "command", Type: "compose.stack.sync", Payload: json.RawMessage(strings.Repeat("x", maximumComposePayloadBytes+1))},
	}
	for _, command := range invalid {
		if result := executor.Execute(context.Background(), command); result.Success {
			t.Fatalf("command unexpectedly succeeded: %#v", command)
		}
	}
	if len(runner.calls) != 0 {
		t.Fatalf("invalid stack payload invoked Docker: %#v", runner.calls)
	}
}

func stackCommand(enabled bool, composeYAML string, overrides map[string]any) types.Command {
	payload := map[string]any{
		"stackId": testStackID, "name": "Main stack", "projectName": "main-stack",
		"enabled": enabled, "revision": 1, "composeYaml": composeYAML,
	}
	for key, value := range overrides {
		payload[key] = value
	}
	encoded, _ := json.Marshal(payload)
	return types.Command{ID: "command", Type: "compose.stack.sync", Payload: encoded}
}

type scriptedResponse struct {
	output runOutput
	err    error
}

type scriptedRunner struct {
	calls     []recordedCall
	responses []scriptedResponse
}

func (r *scriptedRunner) Run(_ context.Context, name string, args []string, _ int64) (runOutput, error) {
	r.calls = append(r.calls, recordedCall{name: name, args: append([]string(nil), args...)})
	if len(r.responses) == 0 {
		return runOutput{}, errors.New("unexpected command")
	}
	response := r.responses[0]
	r.responses = r.responses[1:]
	return response.output, response.err
}

func (r *scriptedRunner) LookPath(string) (string, error) {
	return "/usr/bin/docker", nil
}
