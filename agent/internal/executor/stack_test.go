package executor

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"gatewaycontrol/agent/internal/types"
)

func TestLegacyStackSyncIsPermanentlyUnsupported(t *testing.T) {
	executor := newTestExecutor(t)
	runner := &recordingRunner{}
	executor.runner = runner
	payload, err := json.Marshal(map[string]any{
		"stackId": "123e4567-e89b-12d3-a456-426614174000",
		"name": "Legacy stack",
		"projectName": "legacy",
		"enabled": true,
		"revision": 1,
		"composeYaml": "services:\n  web:\n    image: nginx:1.29\n",
	})
	if err != nil {
		t.Fatal(err)
	}

	result := executor.Execute(context.Background(), types.Command{ID: "command", Type: "compose.stack.sync", Payload: payload})
	if result.Success || !strings.Contains(result.Error, "permanently unsupported") {
		t.Fatalf("result = %#v", result)
	}
	if len(runner.calls) != 0 {
		t.Fatalf("legacy command invoked Docker: %#v", runner.calls)
	}
}

func TestComposeValidatorsUseProjectAndServiceSpecificRules(t *testing.T) {
	if !composeProjectPattern.MatchString("api-gateway_2") || composeProjectPattern.MatchString("Api.Gateway") {
		t.Fatal("Compose project validation does not match the lowercase project-name contract")
	}
	for _, service := range []string{"Web.API", "worker-v2", "QUEUE_1"} {
		if !composeServicePattern.MatchString(service) {
			t.Fatalf("valid Compose service label %q was rejected", service)
		}
	}
}

type recordingRunner struct {
	calls [][]string
}

func (r *recordingRunner) Run(_ context.Context, name string, args []string, _ int64) (runOutput, error) {
	r.calls = append(r.calls, append([]string{name}, args...))
	return runOutput{}, nil
}

func (r *recordingRunner) LookPath(string) (string, error) {
	return "/usr/bin/docker", nil
}
