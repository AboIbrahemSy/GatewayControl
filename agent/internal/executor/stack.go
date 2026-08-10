package executor

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"gatewaycontrol/agent/internal/types"
)

const maximumComposePayloadBytes = 512 * 1024

type stackSyncPayload struct {
	StackID     string `json:"stackId"`
	Name        string `json:"name"`
	ProjectName string `json:"projectName"`
	Enabled     *bool  `json:"enabled"`
	Revision    *int64 `json:"revision"`
	ComposeYAML string `json:"composeYaml"`
}

func (e *Executor) executeStackSync(ctx context.Context, result types.CommandResult, raw json.RawMessage) types.CommandResult {
	payload, err := decodeStackSyncPayload(raw)
	if err != nil {
		return safeSyncFailure(result, "stack payload validation failed")
	}
	commandContext, cancel := context.WithTimeout(ctx, e.timeout)
	defer cancel()
	if commandContext.Err() != nil {
		return safeSyncFailure(result, "stack synchronization canceled")
	}
	stackID := strings.ToLower(payload.StackID)
	directory, err := secureSubdirectory(e.stacksRoot, stackID)
	if err != nil {
		return safeSyncFailure(result, "stack definition storage failed")
	}
	composePath := filepath.Join(directory, "compose.yaml")
	previous, existed, err := readRegularFile(composePath)
	if err != nil {
		return safeSyncFailure(result, "stack definition storage failed")
	}
	if err := writeFileAtomically(composePath, []byte(payload.ComposeYAML), 0o600); err != nil {
		return safeSyncFailure(result, "stack definition storage failed")
	}

	hostDirectory := filepath.Join(e.hostStacksRoot, stackID)
	hostComposePath := filepath.Join(hostDirectory, "compose.yaml")
	baseArgs := []string{
		"compose", "--project-name", payload.ProjectName,
		"--project-directory", hostDirectory, "--file", hostComposePath,
	}
	if _, err := e.runner.Run(commandContext, "docker", append(append([]string{}, baseArgs...), "config", "--quiet"), e.maxOutput); err != nil {
		_ = restoreFile(composePath, previous, existed)
		return safeSyncFailure(result, "stack definition validation failed")
	}

	action := []string{"stop"}
	summary := "compose stack disabled"
	if *payload.Enabled {
		action = []string{"up", "--detach", "--remove-orphans"}
		summary = "compose stack synchronized"
	}
	if _, err := e.runner.Run(commandContext, "docker", append(append([]string{}, baseArgs...), action...), e.maxOutput); err != nil {
		e.rollbackStack(commandContext, baseArgs, composePath, previous, existed)
		return safeSyncFailure(result, "stack synchronization failed")
	}
	return safeSyncSuccess(result, summary)
}

func (e *Executor) rollbackStack(ctx context.Context, baseArgs []string, composePath string, previous []byte, existed bool) {
	if existed {
		if restoreFile(composePath, previous, true) == nil {
			_, _ = e.runner.Run(ctx, "docker", append(append([]string{}, baseArgs...), "up", "--detach", "--remove-orphans"), e.maxOutput)
		}
		return
	}
	// Stop anything partially created while the candidate file is still available, then remove the failed definition.
	_, _ = e.runner.Run(ctx, "docker", append(append([]string{}, baseArgs...), "stop"), e.maxOutput)
	_ = restoreFile(composePath, nil, false)
}

func decodeStackSyncPayload(raw json.RawMessage) (stackSyncPayload, error) {
	var payload stackSyncPayload
	if len(raw) == 0 || len(raw) > maximumComposePayloadBytes {
		return payload, errors.New("stack sync payload must not exceed 512 KiB")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		return payload, fmt.Errorf("invalid stack sync payload: %w", err)
	}
	if decoder.Decode(&struct{}{}) == nil {
		return payload, errors.New("stack sync payload contains trailing data")
	}
	if !connectorUUIDPattern.MatchString(payload.StackID) {
		return payload, errors.New("stackId must be a valid UUID")
	}
	if !validDisplayName(payload.Name, 120) {
		return payload, errors.New("name must contain 1 to 120 valid, non-control characters")
	}
	if !composeProjectPattern.MatchString(payload.ProjectName) {
		return payload, errors.New("projectName must be a valid Compose project name")
	}
	if payload.Enabled == nil {
		return payload, errors.New("enabled must be a boolean")
	}
	if payload.Revision == nil || *payload.Revision < 1 {
		return payload, errors.New("revision must be a positive integer")
	}
	if len(payload.ComposeYAML) < 1 || len(payload.ComposeYAML) > maximumComposePayloadBytes || !utf8.ValidString(payload.ComposeYAML) {
		return payload, errors.New("composeYaml must contain 1 byte to 512 KiB of UTF-8")
	}
	return payload, nil
}

func validDisplayName(name string, maximum int) bool {
	if len(name) < 1 || len(name) > maximum || !utf8.ValidString(name) || strings.TrimSpace(name) != name {
		return false
	}
	for _, character := range name {
		if unicode.IsControl(character) {
			return false
		}
	}
	return true
}

func safeSyncSuccess(result types.CommandResult, summary string) types.CommandResult {
	result.Success = true
	result.ExitCode = 0
	result.Stdout = summary
	result.FinishedAt = time.Now().UTC()
	return result
}

func safeSyncFailure(result types.CommandResult, summary string) types.CommandResult {
	result.ExitCode = -1
	result.Error = summary
	result.FinishedAt = time.Now().UTC()
	return result
}
