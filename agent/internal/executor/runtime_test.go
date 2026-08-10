package executor

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"gatewaycontrol/agent/internal/types"
)

const runtimeContainerID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func TestRuntimeActionRevalidatesLabelsAndUsesOnlyFixedContainerArguments(t *testing.T) {
	executor := newTestExecutor(t)
	runner := &logsScriptedRunner{run: func(args []string) (runOutput, error) {
		switch args[0] {
		case "ps": return runOutput{stdout: runtimeContainerID + "\n", exitCode: 0}, nil
		case "inspect": return runOutput{stdout: runtimeContainerID + "\t/web-1\tproject\tweb\n", exitCode: 0}, nil
		case "container": return runOutput{exitCode: 0}, nil
		}
		return runOutput{}, errors.New("unexpected command")
	}}
	executor.runner = runner
	payload := `{"operationId":"123e4567-e89b-12d3-a456-426614174000","projectName":"project","serviceName":"web","action":"restart","scope":"service"}`
	result := executor.Execute(context.Background(), types.Command{ID: "id", Type: "compose.runtime.action", Payload: json.RawMessage(payload)})
	if !result.Success || result.Matched != 1 || !reflect.DeepEqual(runner.commands[2].args, []string{"container", "restart", runtimeContainerID}) {
		t.Fatalf("result=%#v commands=%#v", result, runner.commands)
	}
	if !reflect.DeepEqual(runner.commands[0].args, []string{"ps", "--all", "--no-trunc", "--filter", "label=com.docker.compose.project=project", "--filter", "label=com.docker.compose.service=web", "--format", "{{.ID}}"}) {
		t.Fatalf("discovery args = %#v", runner.commands[0].args)
	}
}

func TestRuntimeActionRejectsProtectionUnknownFieldsChangedLabelsAndNoMatches(t *testing.T) {
	for name, payload := range map[string]string{
		"protected": `{"operationId":"123e4567-e89b-12d3-a456-426614174000","projectName":"gateway-control","action":"stop","scope":"project"}`,
		"unknown": `{"operationId":"123e4567-e89b-12d3-a456-426614174000","projectName":"project","action":"stop","scope":"project","args":[]}`,
	} {
		t.Run(name, func(t *testing.T) { result := newTestExecutor(t).Execute(context.Background(), types.Command{ID: "id", Type: "compose.runtime.action", Payload: json.RawMessage(payload)}); if result.Success { t.Fatalf("result = %#v", result) } })
	}
	executor := newTestExecutor(t)
	executor.runner = &logsScriptedRunner{run: func(args []string) (runOutput, error) { if args[0] == "ps" { return runOutput{stdout: runtimeContainerID}, nil }; return runOutput{stdout: runtimeContainerID + "\t/web\tother\tweb"}, nil }}
	payload := json.RawMessage(`{"operationId":"123e4567-e89b-12d3-a456-426614174000","projectName":"project","action":"stop","scope":"project"}`)
	if result := executor.Execute(context.Background(), types.Command{ID: "id", Type: "compose.runtime.action", Payload: payload}); result.Success || !strings.Contains(result.Error, "labels changed") { t.Fatalf("result = %#v", result) }
	executor.runner = &logsScriptedRunner{run: func([]string) (runOutput, error) { return runOutput{}, nil }}
	if result := executor.Execute(context.Background(), types.Command{ID: "id", Type: "compose.runtime.action", Payload: payload}); result.Success || !strings.Contains(result.Error, "no matching") { t.Fatalf("result = %#v", result) }
}

func TestRuntimeLogsUseExactDockerLogsBoundsAndRedaction(t *testing.T) {
	executor := newTestExecutor(t)
	runner := &logsScriptedRunner{run: func(args []string) (runOutput, error) {
		switch args[0] {
		case "ps": return runOutput{stdout: runtimeContainerID}, nil
		case "inspect": return runOutput{stdout: runtimeContainerID + "\t/web-1\tproject\tweb"}, nil
		case "logs": return runOutput{stdout: "\x1b[31mtoken=secret\x1b[0m\n", exitCode: 0}, nil
		}
		return runOutput{}, errors.New("unexpected command")
	}}
	executor.runner = runner
	payload := `{"requestId":"123e4567-e89b-12d3-a456-426614174000","projectName":"project","serviceName":"web","tail":1000}`
	result := executor.Execute(context.Background(), types.Command{ID: "id", Type: "compose.runtime.logs", Payload: json.RawMessage(payload)})
	if !result.Success || strings.Contains(result.Logs, "secret") || strings.Contains(result.Logs, "\x1b") || !strings.Contains(result.Logs, "[web-1]") { t.Fatalf("result = %#v", result) }
	if !reflect.DeepEqual(runner.commands[2].args, []string{"logs", "--timestamps", "--tail", "1000", runtimeContainerID}) { t.Fatalf("logs args = %#v", runner.commands[2].args) }
	invalid := strings.Replace(payload, `"tail":1000`, `"tail":1001`, 1)
	if result := executor.Execute(context.Background(), types.Command{ID: "id", Type: "compose.runtime.logs", Payload: json.RawMessage(invalid)}); result.Success { t.Fatalf("result = %#v", result) }
}
