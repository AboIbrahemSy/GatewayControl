package executor

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"gatewaycontrol/agent/internal/types"
)

type recordedCommand struct {
	name string
	args []string
}

type logsScriptedRunner struct {
	commands []recordedCommand
	run      func([]string) (runOutput, error)
}

func (runner *logsScriptedRunner) Run(_ context.Context, name string, args []string, _ int64) (runOutput, error) {
	copyArgs := append([]string(nil), args...)
	runner.commands = append(runner.commands, recordedCommand{name: name, args: copyArgs})
	return runner.run(args)
}

func (*logsScriptedRunner) LookPath(string) (string, error) { return "docker", nil }

func TestServiceLogsUsesExactComposeArgumentsAndTopLevelLogs(t *testing.T) {
	stackID := "123e4567-e89b-12d3-a456-426614174000"
	executor, composePath := executorWithCompose(t, stackID)
	runner := &logsScriptedRunner{run: func(args []string) (runOutput, error) {
		if args[len(args)-2] == "--services" || args[len(args)-1] == "--services" {
			return runOutput{stdout: "web\n", exitCode: 0}, nil
		}
		return runOutput{stdout: "\x1b[31mweb | token=secret\x1b[0m\n", exitCode: 0}, nil
	}}
	executor.runner = runner
	since := time.Now().UTC().Add(-time.Hour).Format(time.RFC3339)
	payload := `{"stackId":"` + stackID + `","service":"web","tail":50,"since":"` + since + `","projectName":"project","stackPath":"` + stackID + `","composePath":"` + stackID + `/compose.yaml"}`
	result := executor.Execute(context.Background(), types.Command{ID: "id", Type: "service.logs.read", Payload: json.RawMessage(payload)})
	if !result.Success || result.Logs == "" || strings.Contains(result.Logs, "secret") || strings.Contains(result.Logs, "\x1b") {
		t.Fatalf("result = %#v", result)
	}
	hostDirectory, _ := executor.hostProjectDirectory(composePath)
	expected := []string{"compose", "--project-name", "project", "--project-directory", hostDirectory, "--file", composePath, "logs", "--no-color", "--timestamps", "--tail", "50", "--since", since, "web"}
	if len(runner.commands) != 2 || runner.commands[1].name != "docker" || !reflect.DeepEqual(runner.commands[1].args, expected) {
		t.Fatalf("commands = %#v, expected logs args %#v", runner.commands, expected)
	}
}

func TestServiceLogsPayloadRejectsUnknownFieldsAndOldSince(t *testing.T) {
	now := time.Now().UTC()
	base := `{"stackId":"123e4567-e89b-12d3-a456-426614174000","service":"web","tail":1,"projectName":"project","stackPath":"123e4567-e89b-12d3-a456-426614174000","composePath":"123e4567-e89b-12d3-a456-426614174000/compose.yaml"`
	for _, payload := range []string{base + `,"args":[]} `, base + `,"since":"` + now.Add(-25*time.Hour).Format(time.RFC3339) + `"}`} {
		if _, err := decodeServiceLogsPayload(json.RawMessage(payload), now); err == nil {
			t.Fatalf("expected payload to be rejected: %s", payload)
		}
	}
}

func executorWithCompose(t *testing.T, stackID string) (*Executor, string) {
	t.Helper()
	root := t.TempDir()
	directory := filepath.Join(root, stackID)
	if err := os.Mkdir(directory, 0o755); err != nil {
		t.Fatal(err)
	}
	composePath := filepath.Join(directory, "compose.yaml")
	if err := os.WriteFile(composePath, []byte("services: {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	executor, err := New(testOptions(t, root))
	if err != nil {
		t.Fatal(err)
	}
	return executor, composePath
}
