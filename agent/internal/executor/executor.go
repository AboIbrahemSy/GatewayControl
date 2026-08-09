package executor

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"gatewaycontrol/agent/internal/types"
)

var stackPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)
var projectPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,62}$`)
var sensitivePattern = regexp.MustCompile(`(?i)(password|passwd|secret|token|api[_-]?key|authorization)(\s*[=:]\s*|\s+)([^\s,;]+)`)
var bearerPattern = regexp.MustCompile(`(?i)bearer\s+[A-Za-z0-9._~+/-]+=*`)

type Executor struct {
	stacksRoot           string
	stateDir             string
	stateVolume          string
	hostStacksRoot       string
	localBackupRoot      string
	hostLocalBackupRoot  string
	nasBackupRoot        string
	hostNASBackupRoot    string
	nasMarker            string
	agentImage           string
	cloudflaredImage     string
	edgeNetwork          string
	traefikDynamicRoot   string
	traefikDynamicVolume string
	timeout              time.Duration
	backupTimeout        time.Duration
	infoTimeout          time.Duration
	maxOutput            int64
	secrets              []string
	runner               commandRunner
}

type Options struct {
	StacksRoot           string
	StateDir             string
	StateVolume          string
	HostStacksRoot       string
	LocalBackupRoot      string
	HostLocalBackupRoot  string
	NASBackupRoot        string
	HostNASBackupRoot    string
	NASMarker            string
	AgentImage           string
	CloudflaredImage     string
	EdgeNetwork          string
	TraefikDynamicRoot   string
	TraefikDynamicVolume string
	Timeout              time.Duration
	BackupTimeout        time.Duration
	InfoTimeout          time.Duration
	MaxOutput            int64
}

func New(options Options, secrets ...string) (*Executor, error) {
	root, err := filepath.Abs(options.StacksRoot)
	if err != nil {
		return nil, fmt.Errorf("resolve stacks root: %w", err)
	}
	stateDir, err := filepath.Abs(options.StateDir)
	if err != nil {
		return nil, fmt.Errorf("resolve state directory: %w", err)
	}
	if !filepath.IsAbs(options.HostStacksRoot) {
		return nil, errors.New("host stacks root must be absolute")
	}
	for name, value := range map[string]string{
		"local backup root": options.LocalBackupRoot, "host local backup root": options.HostLocalBackupRoot,
		"NAS backup root": options.NASBackupRoot, "host NAS backup root": options.HostNASBackupRoot,
	} {
		if !filepath.IsAbs(value) || filepath.Clean(value) != value {
			return nil, fmt.Errorf("%s must be an absolute, clean path", name)
		}
		if strings.ContainsAny(value, ",\r\n\x00") {
			return nil, fmt.Errorf("%s contains unsafe Docker mount characters", name)
		}
	}
	if backupPathsOverlap(options.LocalBackupRoot, options.NASBackupRoot) || backupPathsOverlap(options.HostLocalBackupRoot, options.HostNASBackupRoot) {
		return nil, errors.New("local and NAS backup roots must not overlap")
	}
	if backupPathsOverlap(options.LocalBackupRoot, root) || backupPathsOverlap(options.NASBackupRoot, root) || backupPathsOverlap(options.LocalBackupRoot, stateDir) || backupPathsOverlap(options.NASBackupRoot, stateDir) || backupPathsOverlap(options.HostLocalBackupRoot, options.HostStacksRoot) || backupPathsOverlap(options.HostNASBackupRoot, options.HostStacksRoot) {
		return nil, errors.New("backup roots must not overlap stack or state roots")
	}
	if filepath.Base(options.NASMarker) != options.NASMarker || options.NASMarker == "." || options.NASMarker == ".." {
		return nil, errors.New("NAS marker must be a file name")
	}
	if !pinnedContainerImagePattern.MatchString(options.AgentImage) || !hasPinnedImageReference(options.AgentImage) || strings.HasSuffix(strings.ToLower(options.AgentImage), ":latest") {
		return nil, errors.New("agent image must be explicitly pinned")
	}
	if !dockerObjectNamePattern.MatchString(options.StateVolume) || len(options.StateVolume) < 2 {
		return nil, errors.New("state volume must be a valid Docker volume name")
	}
	if !dockerObjectNamePattern.MatchString(options.EdgeNetwork) {
		return nil, errors.New("edge network must be a valid Docker network name")
	}
	traefikDynamicRoot, err := filepath.Abs(options.TraefikDynamicRoot)
	if err != nil {
		return nil, fmt.Errorf("resolve Traefik dynamic root: %w", err)
	}
	if !dockerObjectNamePattern.MatchString(options.TraefikDynamicVolume) || len(options.TraefikDynamicVolume) < 2 {
		return nil, errors.New("Traefik dynamic volume must be a valid Docker volume name")
	}
	if !pinnedContainerImagePattern.MatchString(options.CloudflaredImage) || !hasPinnedImageReference(options.CloudflaredImage) ||
		strings.HasSuffix(strings.ToLower(options.CloudflaredImage), ":latest") {
		return nil, errors.New("cloudflared image must be explicitly pinned")
	}
	return &Executor{
		stacksRoot: root, stateDir: stateDir, stateVolume: options.StateVolume,
		hostStacksRoot: filepath.Clean(options.HostStacksRoot), cloudflaredImage: options.CloudflaredImage,
		localBackupRoot: options.LocalBackupRoot, hostLocalBackupRoot: options.HostLocalBackupRoot,
		nasBackupRoot: options.NASBackupRoot, hostNASBackupRoot: options.HostNASBackupRoot,
		nasMarker: options.NASMarker, agentImage: options.AgentImage, backupTimeout: options.BackupTimeout,
		edgeNetwork: options.EdgeNetwork, timeout: options.Timeout, infoTimeout: options.InfoTimeout,
		traefikDynamicRoot: traefikDynamicRoot, traefikDynamicVolume: options.TraefikDynamicVolume,
		maxOutput: options.MaxOutput, secrets: secrets, runner: osCommandRunner{},
	}, nil
}

func backupPathsOverlap(first, second string) bool {
	contains := func(parent, child string) bool {
		relative, err := filepath.Rel(filepath.Clean(parent), filepath.Clean(child))
		return err == nil && (relative == "." || relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)))
	}
	return contains(first, second) || contains(second, first)
}

func hasPinnedImageReference(image string) bool {
	if strings.Contains(image, "@sha256:") {
		return true
	}
	lastSlash := strings.LastIndexByte(image, '/')
	return strings.Contains(image[lastSlash+1:], ":")
}

func (e *Executor) Execute(ctx context.Context, command types.Command) types.CommandResult {
	startedAt := time.Now().UTC()
	result := types.CommandResult{CommandID: command.ID, Type: command.Type, ExitCode: -1, StartedAt: startedAt}
	var name string
	var args []string
	var timeout = e.timeout

	switch command.Type {
	case "ping":
		result.Success = true
		result.ExitCode = 0
		result.Stdout = "pong"
		result.FinishedAt = time.Now().UTC()
		return result
	case "docker.info":
		if err := requireEmptyPayload(command.Payload); err != nil {
			return e.failure(result, err)
		}
		name, args, timeout = "docker", []string{"info", "--format", "{{json .}}"}, e.infoTimeout
	case "compose.ps", "compose.up", "compose.stop", "compose.restart":
		payload, err := decodeComposePayload(command.Payload)
		if err != nil {
			return e.failure(result, err)
		}
		composePath, err := e.composePath(payload.ComposePath)
		if err != nil {
			return e.failure(result, err)
		}
		name = "docker"
		hostProjectDirectory, err := e.hostProjectDirectory(composePath)
		if err != nil {
			return e.failure(result, err)
		}
		args = []string{"compose", "--project-name", payload.Project, "--project-directory", hostProjectDirectory, "--file", composePath}
		switch command.Type {
		case "compose.ps":
			args = append(args, "ps", "--all", "--format", "json")
		case "compose.up":
			args = append(args, "up", "--detach", "--remove-orphans")
		case "compose.stop":
			args = append(args, "stop")
		case "compose.restart":
			args = append(args, "restart")
		}
	case "cloudflare.connector.sync":
		return e.executeConnectorSync(ctx, result, command.Payload)
	case "compose.stack.sync":
		return e.executeStackSync(ctx, result, command.Payload)
	case "traefik.route.sync":
		return e.executeRouteSync(result, command.Payload)
	case "service.logs.read":
		return e.executeServiceLogs(ctx, result, command.Payload)
	case "stack.backup.create":
		return e.executeStackBackup(ctx, result, command.Payload)
	case "stack.restore.apply":
		return e.executeStackRestore(ctx, result, command.Payload)
	default:
		return e.failure(result, fmt.Errorf("command type %q is not allowed", command.Type))
	}

	commandContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	output, err := e.runner.Run(commandContext, name, args, e.maxOutput)
	result.Stdout = e.redact(output.stdout)
	result.Stderr = e.redact(output.stderr)
	result.Truncated = output.truncated
	result.FinishedAt = time.Now().UTC()
	if commandContext.Err() == context.DeadlineExceeded {
		result.TimedOut = true
		result.Error = "command timed out"
		return result
	}
	if err == nil {
		result.Success = true
		result.ExitCode = 0
		return result
	}
	if output.exitCode >= 0 {
		result.ExitCode = output.exitCode
		result.Error = "command exited unsuccessfully"
	} else {
		result.Error = e.redact(err.Error())
	}
	return result
}

func (e *Executor) DockerStatus(ctx context.Context) types.DockerStatus {
	if _, err := e.runner.LookPath("docker"); err != nil {
		return types.DockerStatus{}
	}
	status := types.DockerStatus{CLIAvailable: true}
	commandContext, cancel := context.WithTimeout(ctx, e.infoTimeout)
	defer cancel()
	output, err := e.runner.Run(commandContext, "docker", []string{"version", "--format", "{{.Server.Version}}"}, e.maxOutput)
	if err == nil {
		status.DaemonAvailable = true
		status.Version = strings.TrimSpace(output.stdout)
	}
	return status
}

func decodeComposePayload(raw json.RawMessage) (types.ComposePayload, error) {
	var payload types.ComposePayload
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if len(raw) == 0 {
		return payload, errors.New("compose command payload is required")
	}
	if err := decoder.Decode(&payload); err != nil {
		return payload, fmt.Errorf("invalid compose payload: %w", err)
	}
	if decoder.Decode(&struct{}{}) == nil {
		return payload, errors.New("compose payload contains trailing data")
	}
	if !stackPattern.MatchString(payload.Stack) {
		return payload, errors.New("stack must be a valid identifier")
	}
	if !projectPattern.MatchString(payload.Project) {
		return payload, errors.New("project must use 1 to 63 lowercase letters, numbers, underscores, or hyphens and start with a letter or number")
	}
	return payload, nil
}

func requireEmptyPayload(raw json.RawMessage) error {
	if len(raw) == 0 || string(raw) == "null" || string(raw) == "{}" {
		return nil
	}
	return errors.New("command does not accept a payload")
}

func (e *Executor) composePath(value string) (string, error) {
	if value == "" || filepath.IsAbs(value) {
		return "", errors.New("compose_path must be a relative path beneath the stacks root")
	}
	clean := filepath.Clean(value)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", errors.New("compose_path escapes the stacks root")
	}
	candidate := filepath.Join(e.stacksRoot, clean)
	root, err := filepath.EvalSymlinks(e.stacksRoot)
	if err != nil {
		return "", fmt.Errorf("resolve stacks root: %w", err)
	}
	resolved, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		return "", fmt.Errorf("resolve compose path: %w", err)
	}
	relative, err := filepath.Rel(root, resolved)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", errors.New("compose_path resolves outside the stacks root")
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.Mode().IsRegular() {
		return "", errors.New("compose_path must identify a regular file")
	}
	return resolved, nil
}

func (e *Executor) hostProjectDirectory(composePath string) (string, error) {
	relative, err := filepath.Rel(e.stacksRoot, filepath.Dir(composePath))
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", errors.New("compose project directory escapes the stacks root")
	}
	return filepath.Join(e.hostStacksRoot, relative), nil
}

func (e *Executor) failure(result types.CommandResult, err error) types.CommandResult {
	result.Error = e.redact(err.Error())
	result.FinishedAt = time.Now().UTC()
	return result
}

func (e *Executor) redact(value string) string {
	value = bearerPattern.ReplaceAllString(value, "Bearer [REDACTED]")
	value = sensitivePattern.ReplaceAllString(value, "$1$2[REDACTED]")
	for _, secret := range e.secrets {
		if secret != "" {
			value = strings.ReplaceAll(value, secret, "[REDACTED]")
		}
	}
	return value
}

type limitedBuffer struct {
	buffer    bytes.Buffer
	remaining int64
	truncated bool
}

func newLimitedBuffer(limit int64) *limitedBuffer {
	return &limitedBuffer{remaining: limit}
}

func (b *limitedBuffer) Write(contents []byte) (int, error) {
	originalLength := len(contents)
	if int64(len(contents)) > b.remaining {
		contents = contents[:max(0, int(b.remaining))]
		b.truncated = true
	}
	if len(contents) > 0 {
		_, _ = b.buffer.Write(contents)
		b.remaining -= int64(len(contents))
	}
	return originalLength, nil
}

func (b *limitedBuffer) String() string { return b.buffer.String() }

func RuntimePlatform() (string, string) { return runtime.GOOS, runtime.GOARCH }

func subprocessEnvironment() []string {
	environment := os.Environ()
	filtered := environment[:0]
	for _, value := range environment {
		key, _, _ := strings.Cut(value, "=")
		if key == "GATEWAY_ENROLLMENT_TOKEN" || key == "GATEWAY_ENROLLMENT_TOKEN_FILE" ||
			key == "GATEWAY_CONTROL_ENROLLMENT_TOKEN" || key == "GATEWAY_CONTROL_ENROLLMENT_TOKEN_FILE" {
			continue
		}
		filtered = append(filtered, value)
	}
	return filtered
}
