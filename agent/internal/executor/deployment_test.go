package executor

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"gatewaycontrol/agent/internal/types"
)

type recordingRunner struct {
	commands [][]string
	outputs  []runOutput
	errors   []error
}

type timeoutCompensationRunner struct {
	calls              int
	compensationFresh bool
}

func (r *timeoutCompensationRunner) Run(ctx context.Context, _ string, _ []string, _ int64) (runOutput, error) {
	r.calls++
	if r.calls == 1 {
		return runOutput{stdout: `{"services":{"web":{"image":"nginx:1.27.5","restart":"unless-stopped","deploy":{"resources":{"limits":{"cpus":"1.0","memory":"536870912"}}}}}}`}, nil
	}
	if r.calls == 2 {
		<-ctx.Done()
		return runOutput{exitCode: -1}, ctx.Err()
	}
	r.compensationFresh = ctx.Err() == nil
	return runOutput{}, nil
}

func (r *timeoutCompensationRunner) LookPath(string) (string, error) { return "docker", nil }

func (r *recordingRunner) Run(_ context.Context, name string, args []string, _ int64) (runOutput, error) {
	r.commands = append(r.commands, append([]string{name}, args...))
	index := len(r.commands) - 1
	return r.outputs[index], r.errors[index]
}

func (r *recordingRunner) LookPath(string) (string, error) { return "docker", nil }

func TestDeploymentApplyUsesOnlyFixedValidationAndUpCommands(t *testing.T) {
	executor := newTestExecutor(t)
	normalized := `{"services":{"web":{"image":"nginx:1.27.5","restart":"unless-stopped","deploy":{"resources":{"limits":{"cpus":"1.0","memory":"536870912"}}}}}}`
	runner := &recordingRunner{outputs: []runOutput{{stdout: normalized}, {}}, errors: []error{nil, nil}}
	executor.runner = runner
	source := "services:\n  web:\n    image: nginx:1.27.5\n    restart: unless-stopped\n"
	result := executor.Execute(context.Background(), types.Command{ID: "command", Type: "deployment.compose.apply", Payload: deploymentPayload(t, source, "deploy")})
	if !result.Success {
		t.Fatalf("result = %#v", result)
	}
	expectedConfig := []string{"docker", "compose", "--project-name", "reviewed_app", "--file", filepath.Join(executor.hostDeploymentsRoot, "reviewed_app", ".candidate-123e4567-e89b-12d3-a456-426614174001.yaml"), "config", "--format", "json"}
	expectedUp := []string{"docker", "compose", "--project-name", "reviewed_app", "--file", filepath.Join(executor.hostDeploymentsRoot, "reviewed_app", "compose.yaml"), "up", "--detach", "--remove-orphans", "--pull", "missing"}
	if !reflect.DeepEqual(runner.commands, [][]string{expectedConfig, expectedUp}) {
		t.Fatalf("commands = %#v", runner.commands)
	}
	for _, command := range runner.commands {
		joined := strings.Join(command, " ")
		for _, forbidden := range []string{" down", " build", "volume rm", "--volumes"} {
			if strings.Contains(joined, forbidden) { t.Fatalf("unsafe command: %s", joined) }
		}
	}
	info, err := os.Stat(filepath.Join(executor.deploymentsRoot, "reviewed_app", "compose.yaml"))
	if err != nil || info.Mode().Perm() != 0o600 { t.Fatalf("compose mode = %v, error = %v", info.Mode().Perm(), err) }
}

func TestDeploymentStopNeverRemovesProjectResources(t *testing.T) {
	executor := newTestExecutor(t)
	directory, err := secureSubdirectory(executor.deploymentsRoot, "reviewed_app")
	if err != nil { t.Fatal(err) }
	if err := os.WriteFile(filepath.Join(directory, "compose.yaml"), []byte("existing"), 0o600); err != nil { t.Fatal(err) }
	normalized := `{"services":{"web":{"image":"nginx:1.27.5","restart":"unless-stopped","deploy":{"resources":{"limits":{"cpus":"1.0","memory":"536870912"}}}}}}`
	runner := &recordingRunner{outputs: []runOutput{{stdout: normalized}, {}}, errors: []error{nil, nil}}
	executor.runner = runner
	source := "services:\n  web:\n    image: nginx:1.27.5\n    restart: unless-stopped\n"
	result := executor.Execute(context.Background(), types.Command{ID: "command", Type: "deployment.compose.apply", Payload: deploymentPayload(t, source, "stop")})
	if !result.Success || strings.Join(runner.commands[1], " ") != strings.Join([]string{"docker", "compose", "--project-name", "reviewed_app", "--file", filepath.Join(executor.hostDeploymentsRoot, "reviewed_app", "compose.yaml"), "stop"}, " ") {
		t.Fatalf("result = %#v commands = %#v", result, runner.commands)
	}
}

func TestNormalizedDeploymentPolicyRejectsCriticalEscapes(t *testing.T) {
	tests := []string{
		`{"services":{"web":{"image":"nginx:latest","restart":"always","deploy":{"resources":{"limits":{"cpus":"1","memory":"512M"}}}}}}`,
		`{"services":{"web":{"image":"nginx:1.2","restart":"always","privileged":true,"deploy":{"resources":{"limits":{"cpus":"1","memory":"512M"}}}}}}`,
		`{"services":{"web":{"image":"nginx:1.2","restart":"always","volumes":[{"type":"bind","source":"/tmp","target":"/tmp"}],"deploy":{"resources":{"limits":{"cpus":"1","memory":"512M"}}}}}}`,
		`{"services":{"web":{"image":"nginx:1.2","restart":"always","command":["sh"],"deploy":{"resources":{"limits":{"cpus":"1","memory":"512M"}}}}}}`,
		`{"services":{"web":{"image":"nginx:1.2","restart":"always","ports":[{"target":80,"published":"8080"}],"deploy":{"resources":{"limits":{"cpus":"1","memory":"512M"}}}}}}`,
		`{"services":{"web":{"image":"nginx:1.2","restart":"always","expose":["80/tcp"],"deploy":{"resources":{"limits":{"cpus":"1","memory":"512M"}}}}}}`,
		`{"services":{"web":{"image":"nginx:1.2","restart":"always","network_mode":"host","deploy":{"resources":{"limits":{"cpus":"1","memory":"512M"}}}}}}`,
	}
	for _, value := range tests {
		if err := validateNormalizedComposeJSON([]byte(value)); err == nil { t.Fatalf("accepted unsafe normalized Compose: %s", value) }
	}
}

func TestFailedMutationRestoresPriorRevisionWithFreshContextAndVerification(t *testing.T) {
	executor := newTestExecutor(t)
	normalized := `{"services":{"web":{"image":"nginx:1.27.5","restart":"unless-stopped","deploy":{"resources":{"limits":{"cpus":"1.0","memory":"536870912"}}}}}}`
	runner := &recordingRunner{outputs: []runOutput{{stdout: normalized}, {exitCode: 1, stderr: "failed"}, {}, {stdout: "container-id\n"}}, errors: []error{nil, errors.New("up failed"), nil, nil}}
	executor.runner = runner
	source := "services:\n  web:\n    image: nginx:1.27.5\n    restart: unless-stopped\n"
	payload := map[string]any{}
	if err := json.Unmarshal(deploymentPayload(t, source, "deploy"), &payload); err != nil { t.Fatal(err) }
	prior := strings.Replace(source, "1.27.5", "1.27.4", 1); priorSum := sha256.Sum256([]byte(prior))
	payload["priorRevisionId"], payload["priorCompose"], payload["priorChecksum"] = "123e4567-e89b-12d3-a456-426614174002", prior, hex.EncodeToString(priorSum[:])
	raw, _ := json.Marshal(payload)
	result := executor.Execute(context.Background(), types.Command{ID: "command", Type: "deployment.compose.apply", Payload: raw})
	if result.Success || result.Message != "primary=failed compensation_attempted=true compensation_succeeded=true status=prior revision restored and verified" || len(runner.commands) != 4 { t.Fatalf("result = %#v commands = %#v", result, runner.commands) }
	if !reflect.DeepEqual(runner.commands[3][len(runner.commands[3])-3:], []string{"ps", "--all", "--quiet"}) { t.Fatalf("verification command = %#v", runner.commands[3]) }
}

func TestFailedInitialDeploymentRemovesPartialResourcesWithoutVolumes(t *testing.T) {
	executor := newTestExecutor(t)
	normalized := `{"services":{"web":{"image":"nginx:1.27.5","restart":"unless-stopped","deploy":{"resources":{"limits":{"cpus":"1.0","memory":"536870912"}}}}}}`
	runner := &recordingRunner{outputs: []runOutput{{stdout: normalized}, {exitCode: 1}, {}}, errors: []error{nil, errors.New("up timed out"), nil}}
	executor.runner = runner
	source := "services:\n  web:\n    image: nginx:1.27.5\n    restart: unless-stopped\n"
	result := executor.Execute(context.Background(), types.Command{ID: "command", Type: "deployment.compose.apply", Payload: deploymentPayload(t, source, "deploy")})
	if result.Success || !strings.Contains(result.Message, "compensation_succeeded=true") { t.Fatalf("result = %#v", result) }
	expected := []string{"docker", "compose", "--project-name", "reviewed_app", "--file", filepath.Join(executor.hostDeploymentsRoot, "reviewed_app", "compose.yaml"), "down", "--remove-orphans"}
	if !reflect.DeepEqual(runner.commands[2], expected) || strings.Contains(strings.Join(runner.commands[2], " "), "--volumes") { t.Fatalf("cleanup command = %#v", runner.commands[2]) }
	if _, err := os.Stat(filepath.Join(executor.deploymentsRoot, "reviewed_app", "compose.yaml")); !os.IsNotExist(err) { t.Fatalf("failed initial definition remains: %v", err) }
}

func TestTimedOutDeploymentUsesFreshBoundedCompensationContext(t *testing.T) {
	executor := newTestExecutor(t)
	executor.timeout = time.Millisecond
	runner := &timeoutCompensationRunner{}
	executor.runner = runner
	source := "services:\n  web:\n    image: nginx:1.27.5\n    restart: unless-stopped\n"
	result := executor.Execute(context.Background(), types.Command{ID: "command", Type: "deployment.compose.apply", Payload: deploymentPayload(t, source, "deploy")})
	if result.Success || !runner.compensationFresh || !strings.Contains(result.Message, "compensation_succeeded=true") {
		t.Fatalf("result = %#v fresh = %t", result, runner.compensationFresh)
	}
}

func deploymentPayload(t *testing.T, source, action string) json.RawMessage {
	t.Helper(); sum := sha256.Sum256([]byte(source))
	raw, err := json.Marshal(map[string]any{"runId": "123e4567-e89b-12d3-a456-426614174000", "revisionId": "123e4567-e89b-12d3-a456-426614174001", "projectName": "reviewed_app", "sourceCompose": source, "checksum": hex.EncodeToString(sum[:]), "action": action})
	if err != nil { t.Fatal(err) }
	return raw
}
