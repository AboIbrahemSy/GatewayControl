package executor

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"gatewaycontrol/agent/internal/types"
)

var composeServicePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
var terminalEscapePattern = regexp.MustCompile(`\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))`)

type serviceLogsPayload struct {
	StackID     string `json:"stackId"`
	Service     string `json:"service"`
	Tail        int    `json:"tail"`
	Since       string `json:"since,omitempty"`
	ProjectName string `json:"projectName"`
	StackPath   string `json:"stackPath"`
	ComposePath string `json:"composePath"`
}

func (e *Executor) executeServiceLogs(ctx context.Context, result types.CommandResult, raw json.RawMessage) types.CommandResult {
	payload, err := decodeServiceLogsPayload(raw, time.Now().UTC())
	if err != nil {
		return e.failure(result, err)
	}
	composePath, err := e.validatedStackComposePath(payload.StackID, payload.StackPath, payload.ComposePath)
	if err != nil {
		return e.failure(result, err)
	}
	hostDirectory, err := e.hostProjectDirectory(composePath)
	if err != nil {
		return e.failure(result, err)
	}
	base := []string{"compose", "--project-name", payload.ProjectName, "--project-directory", hostDirectory, "--file", composePath}
	commandContext, cancel := context.WithTimeout(ctx, e.timeout)
	defer cancel()
	services, runErr := e.runner.Run(commandContext, "docker", append(append([]string{}, base...), "config", "--services"), e.maxOutput)
	if runErr != nil || !linePresent(services.stdout, payload.Service) {
		return e.failure(result, errors.New("requested service is not defined by the stack"))
	}
	args := append(append([]string{}, base...), "logs", "--no-color", "--timestamps", "--tail", strconv.Itoa(payload.Tail))
	if payload.Since != "" {
		args = append(args, "--since", payload.Since)
	}
	args = append(args, payload.Service)
	output, runErr := e.runner.Run(commandContext, "docker", args, e.maxOutput)
	result.FinishedAt = time.Now().UTC()
	result.Truncated = output.truncated
	result.Logs = e.redact(cleanCommandOutput(output.stdout))
	if commandContext.Err() == context.DeadlineExceeded {
		result.TimedOut, result.Error = true, "command timed out"
		return result
	}
	if runErr != nil {
		result.Error = "service log collection failed"
		result.ExitCode = output.exitCode
		return result
	}
	result.Success, result.ExitCode = true, 0
	return result
}

func decodeServiceLogsPayload(raw json.RawMessage, now time.Time) (serviceLogsPayload, error) {
	var payload serviceLogsPayload
	if err := strictDecode(raw, &payload); err != nil {
		return payload, fmt.Errorf("invalid service logs payload: %w", err)
	}
	if !connectorUUIDPattern.MatchString(payload.StackID) || payload.StackPath != payload.StackID || payload.ComposePath != payload.StackID+"/compose.yaml" {
		return payload, errors.New("stack paths do not match stackId")
	}
	if !composeServicePattern.MatchString(payload.Service) || !composeProjectPattern.MatchString(payload.ProjectName) || payload.Tail < 1 || payload.Tail > 1000 {
		return payload, errors.New("invalid service log request fields")
	}
	if payload.Since != "" {
		since, err := time.Parse(time.RFC3339, payload.Since)
		if err != nil || since.After(now) || now.Sub(since) > 24*time.Hour {
			return payload, errors.New("since must be an RFC3339 timestamp within the last 24 hours")
		}
	}
	return payload, nil
}

func strictDecode(raw json.RawMessage, target any) error {
	if len(raw) == 0 {
		return errors.New("payload is required")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if decoder.Decode(&struct{}{}) == nil {
		return errors.New("payload contains trailing data")
	}
	return nil
}

func (e *Executor) validatedStackComposePath(stackID, stackPath, composePath string) (string, error) {
	if !connectorUUIDPattern.MatchString(stackID) || stackPath != stackID || composePath != stackID+"/compose.yaml" {
		return "", errors.New("invalid stack or compose path")
	}
	return e.composePath(composePath)
}

func linePresent(output, expected string) bool {
	for _, line := range strings.Split(output, "\n") {
		if strings.TrimSpace(line) == expected {
			return true
		}
	}
	return false
}

func cleanCommandOutput(value string) string {
	value = terminalEscapePattern.ReplaceAllString(value, "")
	return strings.Map(func(character rune) rune {
		if character == '\n' || character == '\t' || character == '\r' || character >= 0x20 && character != utf8.RuneError {
			return character
		}
		return -1
	}, value)
}
