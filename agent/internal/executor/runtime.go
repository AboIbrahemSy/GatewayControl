package executor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"gatewaycontrol/agent/internal/types"
)

const maximumRuntimeContainers = 100

type runtimeActionPayload struct {
	OperationID string `json:"operationId"`
	ProjectName string `json:"projectName"`
	ServiceName string `json:"serviceName,omitempty"`
	Action      string `json:"action"`
	Scope       string `json:"scope"`
}

type runtimeLogsPayload struct {
	RequestID   string `json:"requestId"`
	ProjectName string `json:"projectName"`
	ServiceName string `json:"serviceName"`
	Tail        int    `json:"tail"`
	Since       string `json:"since,omitempty"`
}

type runtimeContainer struct {
	id, name, project, service string
}

func (e *Executor) executeRuntimeAction(ctx context.Context, result types.CommandResult, raw json.RawMessage) types.CommandResult {
	var payload runtimeActionPayload
	if err := strictDecode(raw, &payload); err != nil { return e.failure(result, fmt.Errorf("invalid runtime action payload: %w", err)) }
	if !connectorUUIDPattern.MatchString(payload.OperationID) || !composeProjectPattern.MatchString(payload.ProjectName) ||
		!contains([]string{"start", "stop", "restart"}, payload.Action) || !contains([]string{"project", "service"}, payload.Scope) ||
		(payload.Scope == "service") != (payload.ServiceName != "") || payload.ServiceName != "" && !composeServicePattern.MatchString(payload.ServiceName) {
		return e.failure(result, errors.New("invalid runtime action fields"))
	}
	if _, protected := e.protectedProjects[payload.ProjectName]; protected { return e.failure(result, errors.New("runtime project is protected")) }
	commandContext, cancel := context.WithTimeout(ctx, e.timeout); defer cancel()
	containers, err := e.discoverRuntimeContainers(commandContext, payload.ProjectName, payload.ServiceName)
	if err != nil { return e.failure(result, err) }
	if len(containers) == 0 { return e.failure(result, errors.New("no matching runtime containers were found")) }
	ids := make([]string, len(containers)); for index := range containers { ids[index] = containers[index].id }
	output, runErr := e.runner.Run(commandContext, "docker", append([]string{"container", payload.Action}, ids...), e.maxOutput)
	result.FinishedAt, result.Truncated = time.Now().UTC(), output.truncated
	if commandContext.Err() == context.DeadlineExceeded { result.TimedOut, result.Error = true, "command timed out"; return result }
	if runErr != nil { result.ExitCode, result.Error = output.exitCode, "runtime action failed"; return result }
	result.Success, result.ExitCode, result.Message, result.Matched, result.Succeeded = true, 0, "Runtime action completed.", len(containers), len(containers)
	result.Stdout = ""
	return result
}

func (e *Executor) executeRuntimeLogs(ctx context.Context, result types.CommandResult, raw json.RawMessage) types.CommandResult {
	var payload runtimeLogsPayload
	if err := strictDecode(raw, &payload); err != nil { return e.failure(result, fmt.Errorf("invalid runtime logs payload: %w", err)) }
	if !connectorUUIDPattern.MatchString(payload.RequestID) || !composeProjectPattern.MatchString(payload.ProjectName) || !composeServicePattern.MatchString(payload.ServiceName) || payload.Tail < 1 || payload.Tail > 1000 {
		return e.failure(result, errors.New("invalid runtime log request fields"))
	}
	if payload.Since != "" { since, err := time.Parse(time.RFC3339, payload.Since); now := time.Now().UTC(); if err != nil || since.After(now) || now.Sub(since) > 24*time.Hour { return e.failure(result, errors.New("since must be within the last 24 hours")) } }
	commandContext, cancel := context.WithTimeout(ctx, e.timeout); defer cancel()
	containers, err := e.discoverRuntimeContainers(commandContext, payload.ProjectName, payload.ServiceName)
	if err != nil { return e.failure(result, err) }
	if len(containers) == 0 { return e.failure(result, errors.New("no matching runtime containers were found")) }
	var merged strings.Builder; truncated := false
	for index, container := range containers {
		args := []string{"logs", "--timestamps", "--tail", strconv.Itoa(payload.Tail)}
		if payload.Since != "" { args = append(args, "--since", payload.Since) }
		output, runErr := e.runner.Run(commandContext, "docker", append(args, container.id), e.maxOutput)
		if runErr != nil { result.ExitCode, result.Error, result.FinishedAt = output.exitCode, "runtime log collection failed", time.Now().UTC(); return result }
		name := container.name; if !stackPattern.MatchString(name) || validContainerID(name) { name = "container-" + strconv.Itoa(index+1) }
		merged.WriteString("[" + name + "]\n"); merged.WriteString(output.stdout); merged.WriteString(output.stderr)
		if !strings.HasSuffix(merged.String(), "\n") { merged.WriteByte('\n') }
		truncated = truncated || output.truncated
		if int64(merged.Len()) > e.maxOutput { value := merged.String()[:int(e.maxOutput)]; merged.Reset(); merged.WriteString(value); truncated = true; break }
	}
	result.Logs = e.redact(cleanCommandOutput(merged.String())); result.Truncated = truncated; result.Success, result.ExitCode, result.FinishedAt = true, 0, time.Now().UTC()
	return result
}

func (e *Executor) discoverRuntimeContainers(ctx context.Context, project, service string) ([]runtimeContainer, error) {
	filters := []string{"ps", "--all", "--no-trunc", "--filter", "label=com.docker.compose.project=" + project}
	if service != "" { filters = append(filters, "--filter", "label=com.docker.compose.service="+service) }
	filters = append(filters, "--format", `{{.ID}}`)
	output, err := e.runner.Run(ctx, "docker", filters, e.maxOutput)
	if err != nil { return nil, errors.New("runtime container discovery failed") }
	ids := strings.Fields(output.stdout); if len(ids) > maximumRuntimeContainers { return nil, errors.New("runtime target exceeds the container limit") }
	sort.Strings(ids); containers := make([]runtimeContainer, 0, len(ids))
	seen := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		if _, exists := seen[id]; exists { continue }; seen[id] = struct{}{}
		if !validContainerID(id) { return nil, errors.New("runtime discovery returned an invalid container identity") }
		inspect, inspectErr := e.runner.Run(ctx, "docker", []string{"inspect", "--format", `{{.Id}}\t{{.Name}}\t{{index .Config.Labels "com.docker.compose.project"}}\t{{index .Config.Labels "com.docker.compose.service"}}`, id}, e.maxOutput)
		if inspectErr != nil { return nil, errors.New("runtime container revalidation failed") }
		fields := strings.Split(strings.TrimSpace(inspect.stdout), "\t"); if len(fields) != 4 || fields[0] != id || fields[2] != project || !composeServicePattern.MatchString(fields[3]) || service != "" && fields[3] != service { return nil, errors.New("runtime container labels changed during revalidation") }
		containers = append(containers, runtimeContainer{id: id, name: strings.TrimPrefix(fields[1], "/"), project: fields[2], service: fields[3]})
	}
	return containers, nil
}

func validContainerID(value string) bool {
	if len(value) < 12 || len(value) > 64 { return false }
	for _, character := range value { if character < '0' || character > '9' && character < 'a' || character > 'f' { return false } }
	return true
}

func contains(values []string, value string) bool { for _, candidate := range values { if candidate == value { return true } }; return false }
