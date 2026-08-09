package executor

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"gatewaycontrol/agent/internal/types"
)

const connectorStateMount = "/run/gateway-agent-state"

var connectorUUIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)
var dockerObjectNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)
var pinnedContainerImagePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._/-]*(?::[a-z0-9][a-z0-9._-]*)?(?:@sha256:[a-f0-9]{64})?$`)
var numericIDPattern = regexp.MustCompile(`^[0-9]+$`)

type connectorSyncPayload struct {
	ConnectorID string `json:"connectorId"`
	Name        string `json:"name"`
	Enabled     *bool  `json:"enabled"`
	Token       string `json:"token"`
}

func (e *Executor) executeConnectorSync(ctx context.Context, result types.CommandResult, raw json.RawMessage) types.CommandResult {
	payload, err := decodeConnectorSyncPayload(raw)
	if err != nil {
		return e.failure(result, err)
	}
	commandContext, cancel := context.WithTimeout(ctx, e.timeout)
	defer cancel()
	containerName := connectorContainerName(payload.ConnectorID)
	candidateContainerName := containerName + "-candidate"
	tokenPath := e.connectorTokenPath(payload.ConnectorID)
	if err := commandContext.Err(); err != nil {
		return e.connectorFailure(result, commandContext, payload.Token, "synchronize connector", runOutput{}, err)
	}

	if !*payload.Enabled {
		output, removeErr := e.removeContainer(commandContext, containerName)
		tokenErr := removeToken(tokenPath)
		if removeErr != nil {
			return e.connectorFailure(result, commandContext, payload.Token, "remove connector container", output, removeErr)
		}
		if tokenErr != nil {
			return e.connectorFailure(result, commandContext, payload.Token, "remove connector token", runOutput{}, tokenErr)
		}
		return connectorSuccess(result, "cloudflare connector disabled")
	}

	if err := writeTokenAtomically(tokenPath, payload.Token); err != nil {
		return e.connectorFailure(result, commandContext, payload.Token, "persist connector token", runOutput{}, err)
	}
	if output, err := e.ensureNetwork(commandContext); err != nil {
		return e.connectorFailure(result, commandContext, payload.Token, "ensure edge network", output, err)
	}
	if output, err := e.removeContainer(commandContext, candidateContainerName); err != nil {
		return e.connectorFailure(result, commandContext, payload.Token, "remove stale connector candidate", output, err)
	}

	containerTokenPath := connectorStateMount + "/connectors/" + strings.ToLower(payload.ConnectorID) + ".token"
	mount := "type=volume,source=" + e.stateVolume + ",target=" + connectorStateMount + ",readonly"
	args := []string{
		"container", "create", "--name", candidateContainerName,
		"--restart", "unless-stopped", "--network", e.edgeNetwork,
		"--mount", mount,
	}
	if identity := currentNumericIdentity(); identity != "" {
		args = append(args, "--user", identity)
	}
	args = append(args, e.cloudflaredImage, "tunnel", "--no-autoupdate", "run", "--token-file", containerTokenPath)
	if output, err := e.runner.Run(commandContext, "docker", args, e.maxOutput); err != nil {
		return e.connectorFailure(result, commandContext, payload.Token, "create connector container", output, err)
	}
	if output, err := e.runner.Run(commandContext, "docker", []string{"container", "start", candidateContainerName}, e.maxOutput); err != nil {
		return e.connectorFailure(result, commandContext, payload.Token, "start connector container", output, err)
	}
	output, err := e.runner.Run(commandContext, "docker", []string{"container", "inspect", "--format", "{{.State.Running}}", candidateContainerName}, e.maxOutput)
	if err != nil || strings.TrimSpace(output.stdout) != "true" {
		if err == nil {
			err = errors.New("container did not enter the running state")
		}
		return e.connectorFailure(result, commandContext, payload.Token, "verify connector container", output, err)
	}
	if output, err := e.removeContainer(commandContext, containerName); err != nil {
		return e.connectorFailure(result, commandContext, payload.Token, "retire previous connector container", output, err)
	}
	if output, err := e.runner.Run(commandContext, "docker", []string{"container", "rename", candidateContainerName, containerName}, e.maxOutput); err != nil {
		return e.connectorFailure(result, commandContext, payload.Token, "promote connector candidate", output, err)
	}
	return connectorSuccess(result, "cloudflare connector enabled")
}

func decodeConnectorSyncPayload(raw json.RawMessage) (connectorSyncPayload, error) {
	var payload connectorSyncPayload
	if len(raw) == 0 {
		return payload, errors.New("connector sync payload is required")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		return payload, fmt.Errorf("invalid connector sync payload: %w", err)
	}
	if decoder.Decode(&struct{}{}) == nil {
		return payload, errors.New("connector sync payload contains trailing data")
	}
	if !connectorUUIDPattern.MatchString(payload.ConnectorID) {
		return payload, errors.New("connectorId must be a valid UUID")
	}
	if !validConnectorName(payload.Name) {
		return payload, errors.New("name must contain 1 to 120 valid, non-control characters")
	}
	if payload.Enabled == nil {
		return payload, errors.New("enabled must be a boolean")
	}
	if len(payload.Token) < 20 || len(payload.Token) > 4096 {
		return payload, errors.New("token must contain 20 to 4096 bytes")
	}
	return payload, nil
}

func validConnectorName(name string) bool {
	if len(name) < 1 || len(name) > 120 || !utf8.ValidString(name) || strings.TrimSpace(name) != name {
		return false
	}
	for _, character := range name {
		if unicode.IsControl(character) {
			return false
		}
	}
	return true
}

func connectorContainerName(connectorID string) string {
	return "gateway-cloudflared-" + strings.ToLower(connectorID)
}

func (e *Executor) connectorTokenPath(connectorID string) string {
	return filepath.Join(e.stateDir, "connectors", strings.ToLower(connectorID)+".token")
}

func (e *Executor) ensureNetwork(ctx context.Context) (runOutput, error) {
	inspectArgs := []string{"network", "inspect", e.edgeNetwork}
	output, err := e.runner.Run(ctx, "docker", inspectArgs, e.maxOutput)
	if err == nil {
		return output, nil
	}
	if !dockerObjectMissing(output) {
		return output, err
	}
	output, err = e.runner.Run(ctx, "docker", []string{"network", "create", e.edgeNetwork}, e.maxOutput)
	if err == nil {
		return output, nil
	}
	// A competing agent may have created the shared network after the first inspection.
	verifyOutput, verifyErr := e.runner.Run(ctx, "docker", inspectArgs, e.maxOutput)
	if verifyErr == nil {
		return verifyOutput, nil
	}
	return output, err
}

func (e *Executor) removeContainer(ctx context.Context, name string) (runOutput, error) {
	output, err := e.runner.Run(ctx, "docker", []string{"container", "inspect", name}, e.maxOutput)
	if err != nil {
		if dockerObjectMissing(output) {
			return output, nil
		}
		return output, err
	}
	return e.runner.Run(ctx, "docker", []string{"container", "rm", "--force", name}, e.maxOutput)
}

func dockerObjectMissing(output runOutput) bool {
	message := strings.ToLower(output.stdout + "\n" + output.stderr)
	return strings.Contains(message, "no such container") || strings.Contains(message, "no such object") ||
		strings.Contains(message, "no container with name") || strings.Contains(message, "no such network")
}

func writeTokenAtomically(path, token string) error {
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("create connector state directory: %w", err)
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		return fmt.Errorf("secure connector state directory: %w", err)
	}
	temporary, err := os.CreateTemp(directory, ".connector-token-*")
	if err != nil {
		return fmt.Errorf("create temporary connector token: %w", err)
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return fmt.Errorf("secure temporary connector token: %w", err)
	}
	if _, err := temporary.WriteString(token); err != nil {
		temporary.Close()
		return fmt.Errorf("write connector token: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return fmt.Errorf("sync connector token: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close connector token: %w", err)
	}
	if runtime.GOOS == "windows" {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("remove previous connector token: %w", err)
		}
	}
	if err := os.Rename(temporaryName, path); err != nil {
		return fmt.Errorf("replace connector token: %w", err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return fmt.Errorf("secure connector token: %w", err)
	}
	if runtime.GOOS != "windows" {
		directoryHandle, err := os.Open(directory)
		if err != nil {
			return fmt.Errorf("open connector state directory for sync: %w", err)
		}
		defer directoryHandle.Close()
		if err := directoryHandle.Sync(); err != nil {
			return fmt.Errorf("sync connector state directory: %w", err)
		}
	}
	return nil
}

func removeToken(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove connector token: %w", err)
	}
	return nil
}

func currentNumericIdentity() string {
	current, err := user.Current()
	if err != nil || !numericIDPattern.MatchString(current.Uid) || !numericIDPattern.MatchString(current.Gid) {
		return ""
	}
	if _, err := strconv.ParseUint(current.Uid, 10, 32); err != nil {
		return ""
	}
	if _, err := strconv.ParseUint(current.Gid, 10, 32); err != nil {
		return ""
	}
	return current.Uid + ":" + current.Gid
}

func connectorSuccess(result types.CommandResult, message string) types.CommandResult {
	result.Success = true
	result.ExitCode = 0
	result.Stdout = message
	result.FinishedAt = time.Now().UTC()
	return result
}

func (e *Executor) connectorFailure(result types.CommandResult, ctx context.Context, token, action string, output runOutput, err error) types.CommandResult {
	result.ExitCode = output.exitCode
	if result.ExitCode == 0 {
		result.ExitCode = -1
	}
	result.Stderr = e.redactConnectorOutput(output.stderr, token)
	result.Stdout = e.redactConnectorOutput(output.stdout, token)
	result.Truncated = output.truncated
	result.Error = action + " failed"
	if ctx.Err() == context.DeadlineExceeded {
		result.TimedOut = true
		result.Error = action + " timed out"
	} else if output.exitCode < 0 && err != nil {
		result.Stderr = strings.TrimSpace(result.Stderr + "\n" + e.redactConnectorOutput(err.Error(), token))
	}
	result.FinishedAt = time.Now().UTC()
	return result
}

func (e *Executor) redactConnectorOutput(value, token string) string {
	return strings.ReplaceAll(e.redact(value), token, "[REDACTED]")
}
