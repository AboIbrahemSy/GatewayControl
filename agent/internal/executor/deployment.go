package executor

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"gatewaycontrol/agent/internal/types"
)

const maximumDeploymentPayloadBytes = 3 * 1024 * 1024
const maximumDeploymentComposeBytes = 1024 * 1024

var revisionChecksumPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

type deploymentComposePayload struct {
	RunID           string `json:"runId"`
	RevisionID      string `json:"revisionId"`
	ProjectName     string `json:"projectName"`
	SourceCompose   string `json:"sourceCompose"`
	Checksum        string `json:"checksum"`
	Action          string `json:"action"`
	PriorRevisionID string `json:"priorRevisionId,omitempty"`
	PriorCompose    string `json:"priorCompose,omitempty"`
	PriorChecksum   string `json:"priorChecksum,omitempty"`
}

func (e *Executor) executeDeploymentComposeApply(ctx context.Context, result types.CommandResult, raw json.RawMessage) types.CommandResult {
	payload, err := decodeDeploymentComposePayload(raw)
	if err != nil {
		return e.failure(result, errors.New("deployment payload validation failed"))
	}
	if _, protected := e.protectedProjects[payload.ProjectName]; protected {
		return e.failure(result, errors.New("deployment project is protected"))
	}
	commandContext, cancel := context.WithTimeout(ctx, e.timeout)
	defer cancel()
	directory, err := secureSubdirectory(e.deploymentsRoot, payload.ProjectName)
	if err != nil {
		return e.failure(result, errors.New("deployment storage failed"))
	}
	composePath := filepath.Join(directory, "compose.yaml")
	candidatePath := filepath.Join(directory, ".candidate-"+strings.ToLower(payload.RevisionID)+".yaml")
	defer os.Remove(candidatePath)
	if err := writeFileAtomically(candidatePath, []byte(payload.SourceCompose), 0o600); err != nil {
		return e.failure(result, errors.New("deployment storage failed"))
	}
	hostCandidatePath := filepath.Join(e.hostDeploymentsRoot, payload.ProjectName, filepath.Base(candidatePath))
	configuration, err := e.runner.Run(commandContext, "docker", []string{"compose", "--project-name", payload.ProjectName, "--file", hostCandidatePath, "config", "--format", "json"}, e.maxOutput)
	if err != nil || configuration.truncated {
		return e.failure(result, errors.New("deployment Compose validation failed"))
	}
	if err := validateNormalizedComposeJSON([]byte(configuration.stdout)); err != nil {
		return e.failure(result, errors.New("deployment policy validation failed"))
	}
	if payload.Action == "stop" {
		if _, exists, readErr := readRegularFile(composePath); readErr != nil || !exists {
			return e.failure(result, errors.New("deployed revision is unavailable"))
		}
		return e.runDeploymentAction(commandContext, result, payload.ProjectName, composePath, []string{"stop"})
	}
	previous, existed, err := readRegularFile(composePath)
	if err != nil {
		return e.failure(result, errors.New("deployment storage failed"))
	}
	if err := writeFileAtomically(composePath, []byte(payload.SourceCompose), 0o600); err != nil {
		return e.failure(result, errors.New("deployment storage failed"))
	}
	hostComposePath := filepath.Join(e.hostDeploymentsRoot, payload.ProjectName, "compose.yaml")
	args := []string{"compose", "--project-name", payload.ProjectName, "--file", hostComposePath, "up", "--detach", "--remove-orphans", "--pull", "missing"}
	output, runErr := e.runner.Run(commandContext, "docker", args, e.maxOutput)
	if runErr == nil {
		result.Success, result.ExitCode, result.Stdout, result.Stderr, result.Truncated, result.FinishedAt = true, 0, "deployment applied", e.redact(output.stderr), output.truncated, time.Now().UTC()
		return result
	}
	rollbackContext, rollbackCancel := context.WithTimeout(context.WithoutCancel(ctx), e.timeout)
	defer rollbackCancel()
	rollbackSucceeded := false
	rollbackStatus := "initial cleanup failed"
	if payload.PriorRevisionID != "" {
		if writeFileAtomically(composePath, []byte(payload.PriorCompose), 0o600) == nil {
			_, rollbackErr := e.runner.Run(rollbackContext, "docker", args, e.maxOutput)
			if rollbackErr == nil {
				verification, verifyErr := e.runner.Run(rollbackContext, "docker", []string{"compose", "--project-name", payload.ProjectName, "--file", hostComposePath, "ps", "--all", "--quiet"}, e.maxOutput)
				rollbackSucceeded = verifyErr == nil && !verification.truncated && strings.TrimSpace(verification.stdout) != ""
			}
		}
		rollbackStatus = "prior revision rollback failed"
		if rollbackSucceeded {
			rollbackStatus = "prior revision restored and verified"
		}
	} else {
		_, cleanupErr := e.runner.Run(rollbackContext, "docker", []string{"compose", "--project-name", payload.ProjectName, "--file", hostComposePath, "down", "--remove-orphans"}, e.maxOutput)
		restoreErr := restoreFile(composePath, previous, existed)
		rollbackSucceeded = cleanupErr == nil && restoreErr == nil
		if rollbackSucceeded {
			rollbackStatus = "initial resources removed and definition restored"
		}
	}
	result.ExitCode = output.exitCode
	result.Stderr = e.redact(output.stderr)
	result.Truncated = output.truncated
	result.Error = "deployment failed after Compose mutation"
	result.Message = fmt.Sprintf("primary=failed compensation_attempted=true compensation_succeeded=%t status=%s", rollbackSucceeded, rollbackStatus)
	result.FinishedAt = time.Now().UTC()
	return result
}

func (e *Executor) runDeploymentAction(ctx context.Context, result types.CommandResult, projectName, composePath string, action []string) types.CommandResult {
	hostComposePath := filepath.Join(e.hostDeploymentsRoot, projectName, filepath.Base(composePath))
	output, err := e.runner.Run(ctx, "docker", append([]string{"compose", "--project-name", projectName, "--file", hostComposePath}, action...), e.maxOutput)
	result.Stdout, result.Stderr, result.Truncated, result.FinishedAt = e.redact(output.stdout), e.redact(output.stderr), output.truncated, time.Now().UTC()
	if err == nil {
		result.Success, result.ExitCode = true, 0
		return result
	}
	result.ExitCode, result.Error = output.exitCode, "deployment action failed"
	return result
}

func decodeDeploymentComposePayload(raw json.RawMessage) (deploymentComposePayload, error) {
	var payload deploymentComposePayload
	if len(raw) == 0 || len(raw) > maximumDeploymentPayloadBytes {
		return payload, errors.New("deployment payload exceeds 1 MiB")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		return payload, err
	}
	if decoder.Decode(&struct{}{}) == nil {
		return payload, errors.New("deployment payload contains trailing data")
	}
	if !connectorUUIDPattern.MatchString(payload.RunID) || !connectorUUIDPattern.MatchString(payload.RevisionID) || !composeProjectPattern.MatchString(payload.ProjectName) {
		return payload, errors.New("deployment identifiers are invalid")
	}
	if payload.Action != "deploy" && payload.Action != "rollback" && payload.Action != "stop" {
		return payload, errors.New("deployment action is invalid")
	}
	if !validComposeChecksum(payload.SourceCompose, payload.Checksum) {
		return payload, errors.New("deployment source checksum is invalid")
	}
	if payload.PriorRevisionID != "" {
		if !connectorUUIDPattern.MatchString(payload.PriorRevisionID) || !validComposeChecksum(payload.PriorCompose, payload.PriorChecksum) {
			return payload, errors.New("prior deployment revision is invalid")
		}
	} else if payload.PriorCompose != "" || payload.PriorChecksum != "" {
		return payload, errors.New("prior deployment fields are incomplete")
	}
	return payload, nil
}

func validComposeChecksum(compose, checksum string) bool {
	if len(compose) < 1 || len(compose) > maximumDeploymentComposeBytes || !utf8.ValidString(compose) || !revisionChecksumPattern.MatchString(checksum) {
		return false
	}
	sum := sha256.Sum256([]byte(compose))
	return hex.EncodeToString(sum[:]) == checksum
}

func validateNormalizedComposeJSON(raw []byte) error {
	var model map[string]any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&model); err != nil {
		return err
	}
	services, ok := model["services"].(map[string]any)
	if !ok || len(services) < 1 || len(services) > 50 {
		return errors.New("normalized services are invalid")
	}
	for name, value := range services {
		if !stackPattern.MatchString(name) {
			return errors.New("normalized service name is invalid")
		}
		service, ok := value.(map[string]any)
		if !ok {
			return errors.New("normalized service is invalid")
		}
		image, ok := service["image"].(string)
		if !ok || !hasPinnedImageReference(image) || strings.HasSuffix(strings.ToLower(image), ":latest") {
			return errors.New("normalized image is not pinned")
		}
		if privileged, _ := service["privileged"].(bool); privileged {
			return errors.New("privileged service is forbidden")
		}
		for _, key := range []string{"build", "use_api_socket", "devices", "cap_add", "command", "entrypoint"} {
			if value, exists := service[key]; exists && value != nil {
				return fmt.Errorf("normalized %s is forbidden", key)
			}
		}
		for _, key := range []string{"network_mode", "ports", "expose", "pid", "ipc"} {
			if value, exists := service[key]; exists && value != nil {
				return fmt.Errorf("normalized %s is forbidden", key)
			}
		}
		if options, ok := service["security_opt"].([]any); ok {
			for _, option := range options {
				text := strings.ToLower(fmt.Sprint(option))
				if strings.Contains(text, "unconfined") || strings.Contains(text, "label:disable") {
					return errors.New("isolation-disabling security option is forbidden")
				}
			}
		}
		if mounts, ok := service["volumes"].([]any); ok {
			for _, mountValue := range mounts {
				mount, ok := mountValue.(map[string]any)
				source, sourceOK := mount["source"].(string)
				if !ok || mount["type"] != "volume" || !sourceOK || !stackPattern.MatchString(source) || strings.ContainsAny(source, `/\\`) {
					return errors.New("bind or socket mount is forbidden")
				}
			}
		}
		if restart, _ := service["restart"].(string); restart != "always" && restart != "unless-stopped" && restart != "on-failure" {
			return errors.New("restart policy is required")
		}
		deploy, ok := service["deploy"].(map[string]any)
		if !ok {
			return errors.New("deploy resource limits are required")
		}
		resources, ok := deploy["resources"].(map[string]any)
		if !ok {
			return errors.New("deploy resource limits are required")
		}
		limits, ok := resources["limits"].(map[string]any)
		if !ok || limits["cpus"] == nil || limits["memory"] == nil {
			return errors.New("CPU and memory limits are required")
		}
		if reservations, ok := resources["reservations"].(map[string]any); ok && reservations["devices"] != nil {
			return errors.New("device reservations are forbidden")
		}
	}
	for _, kind := range []string{"volumes", "networks"} {
		if resources, ok := model[kind].(map[string]any); ok {
			for _, value := range resources {
				definition, ok := value.(map[string]any)
				if !ok || definition["external"] == true { return fmt.Errorf("external %s are forbidden", kind) }
			}
		}
	}
	return nil
}
