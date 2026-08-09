package agent

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"regexp"
	"time"

	"gatewaycontrol/agent/internal/backoff"
	"gatewaycontrol/agent/internal/config"
	"gatewaycontrol/agent/internal/control"
	"gatewaycontrol/agent/internal/executor"
	"gatewaycontrol/agent/internal/state"
	"gatewaycontrol/agent/internal/telemetry"
	"gatewaycontrol/agent/internal/types"
)

var commandIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)

const minimumEmptyPollDelay = 2 * time.Second
const maximumEmptyPollDelay = 30 * time.Second

type controlClient interface {
	Enroll(context.Context, string) (state.Credentials, error)
	Heartbeat(context.Context, state.Credentials, types.Heartbeat) error
	Telemetry(context.Context, state.Credentials, types.Telemetry) error
	Commands(context.Context, state.Credentials) ([]types.Command, error)
	SubmitResult(context.Context, state.Credentials, types.CommandResult) error
}

type commandExecutor interface {
	Execute(context.Context, types.Command) types.CommandResult
	DockerStatus(context.Context) types.DockerStatus
}

type telemetryCollector interface {
	Collect(context.Context) (types.Telemetry, error)
}

type Agent struct {
	config    config.Config
	version   string
	logger    *slog.Logger
	store     *state.Store
	client    controlClient
	executor  commandExecutor
	telemetry telemetryCollector
}

func New(cfg config.Config, version string, logger *slog.Logger) (*Agent, error) {
	store, err := state.Open(cfg.StateDir)
	if err != nil {
		return nil, err
	}
	return &Agent{
		config: cfg, version: version, logger: logger, store: store,
		client: control.New(cfg.ControlURL, cfg.LongPollTimeout, version),
	}, nil
}

func (a *Agent) Run(ctx context.Context) error {
	credentials, err := a.ensureEnrollment(ctx)
	if err != nil {
		return err
	}
	a.executor, err = executor.New(executor.Options{
		StacksRoot: a.config.StacksRoot, StateDir: a.config.StateDir, StateVolume: a.config.StateVolume,
		HostStacksRoot: a.config.HostStacksRoot, CloudflaredImage: a.config.CloudflaredImage,
		LocalBackupRoot: a.config.LocalBackupRoot, HostLocalBackupRoot: a.config.HostLocalBackupRoot,
		NASBackupRoot: a.config.NASBackupRoot, HostNASBackupRoot: a.config.HostNASBackupRoot,
		NASMarker: a.config.NASMarker, AgentImage: a.config.AgentImage, BackupTimeout: a.config.BackupTimeout,
		EdgeNetwork: a.config.EdgeNetwork, Timeout: a.config.CommandTimeout,
		TraefikDynamicRoot: a.config.TraefikDynamicRoot, TraefikDynamicVolume: a.config.TraefikDynamicVolume,
		InfoTimeout: a.config.DockerInfoTimeout, MaxOutput: a.config.MaxOutputBytes,
	}, a.config.EnrollmentToken, credentials.APICredential)
	if err != nil {
		return err
	}
	a.logger.Info("agent started", "agent_id", credentials.AgentID, "version", a.version)
	a.telemetry = telemetry.New(a.config.HostProcRoot)

	heartbeatDone := make(chan struct{})
	telemetryDone := make(chan struct{})
	go func() {
		defer close(heartbeatDone)
		a.heartbeatLoop(ctx, credentials)
	}()
	go func() {
		defer close(telemetryDone)
		a.telemetryLoop(ctx, credentials)
	}()
	err = a.commandLoop(ctx, credentials)
	if ctx.Err() != nil {
		<-heartbeatDone
		<-telemetryDone
		return nil
	}
	return err
}

func (a *Agent) telemetryLoop(ctx context.Context, credentials state.Credentials) {
	ticker := time.NewTicker(a.config.MetricsInterval)
	defer ticker.Stop()
	for {
		a.sendTelemetry(ctx, credentials)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (a *Agent) sendTelemetry(ctx context.Context, credentials state.Credentials) {
	snapshot, err := a.telemetry.Collect(ctx)
	if err == nil {
		err = a.client.Telemetry(ctx, credentials, snapshot)
	}
	if err != nil && ctx.Err() == nil {
		a.logger.Warn("telemetry collection or delivery failed", "error", err)
	}
}

func (a *Agent) ensureEnrollment(ctx context.Context) (state.Credentials, error) {
	if credentials, found := a.store.Credentials(); found {
		return credentials, nil
	}
	if a.config.EnrollmentToken == "" {
		return state.Credentials{}, errors.New("GATEWAY_ENROLLMENT_TOKEN or its _FILE variant is required for initial enrollment")
	}
	retry := backoff.New(time.Second, time.Minute)
	for {
		credentials, err := a.client.Enroll(ctx, a.config.EnrollmentToken)
		if err == nil {
			if err := a.store.SaveCredentials(credentials); err != nil {
				return state.Credentials{}, err
			}
			a.config.EnrollmentToken = ""
			a.logger.Info("agent enrollment completed", "agent_id", credentials.AgentID)
			return credentials, nil
		}
		if ctx.Err() != nil {
			return state.Credentials{}, ctx.Err()
		}
		delay := retry.Next()
		a.logger.Warn("agent enrollment failed; retrying", "error", err, "delay", delay)
		if err := sleep(ctx, delay); err != nil {
			return state.Credentials{}, err
		}
	}
}

func (a *Agent) heartbeatLoop(ctx context.Context, credentials state.Credentials) {
	ticker := time.NewTicker(a.config.HeartbeatInterval)
	defer ticker.Stop()
	for {
		a.sendHeartbeat(ctx, credentials)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (a *Agent) sendHeartbeat(ctx context.Context, credentials state.Credentials) {
	hostname, err := os.Hostname()
	if err != nil {
		hostname = "unknown"
	}
	operatingSystem, architecture := executor.RuntimePlatform()
	heartbeat := types.Heartbeat{
		Hostname: hostname, OS: operatingSystem, Architecture: architecture,
		AgentVersion: a.version, Docker: a.executor.DockerStatus(ctx),
	}
	if err := a.client.Heartbeat(ctx, credentials, heartbeat); err != nil && ctx.Err() == nil {
		a.logger.Warn("heartbeat failed", "error", err)
	}
}

func (a *Agent) commandLoop(ctx context.Context, credentials state.Credentials) error {
	retry := backoff.New(time.Second, time.Minute)
	emptyPollDelay := minimumEmptyPollDelay
	for {
		if err := a.deliverPending(ctx, credentials); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			delay := retry.Next()
			a.logger.Warn("result delivery failed; retrying", "error", err, "delay", delay)
			if err := sleep(ctx, delay); err != nil {
				return nil
			}
			continue
		}
		commands, err := a.client.Commands(ctx, credentials)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			delay := retry.Next()
			a.logger.Warn("command poll failed; retrying", "error", err, "delay", delay)
			if err := sleep(ctx, delay); err != nil {
				return nil
			}
			continue
		}
		retry.Reset()
		if len(commands) == 0 {
			if err := sleep(ctx, emptyPollDelay); err != nil {
				return nil
			}
			emptyPollDelay = min(emptyPollDelay*2, maximumEmptyPollDelay)
			continue
		}
		emptyPollDelay = minimumEmptyPollDelay
		a.processCommands(ctx, credentials, commands)
	}
}

func (a *Agent) processCommands(ctx context.Context, credentials state.Credentials, commands []types.Command) {
	for _, command := range commands {
		if ctx.Err() != nil {
			return
		}
		if err := a.handleCommand(ctx, credentials, command); err != nil {
			a.logger.Warn("command handling failed", "command_id", command.ID, "error", err)
		}
	}
}

func (a *Agent) handleCommand(ctx context.Context, credentials state.Credentials, command types.Command) error {
	if !commandIDPattern.MatchString(command.ID) {
		return errors.New("control plane returned an invalid command ID")
	}
	if record, found := a.store.Command(command.ID); found {
		if record.Result != nil {
			return a.deliverResult(ctx, credentials, *record.Result)
		}
		result := interruptedResult(command)
		if err := a.store.SaveResult(result); err != nil {
			return err
		}
		return a.deliverResult(ctx, credentials, result)
	}
	if err := a.store.MarkRunning(command.ID); err != nil {
		return err
	}
	result := a.executor.Execute(ctx, command)
	if err := a.store.SaveResult(result); err != nil {
		return err
	}
	return a.deliverResult(ctx, credentials, result)
}

func (a *Agent) deliverPending(ctx context.Context, credentials state.Credentials) error {
	for _, result := range a.store.PendingResults() {
		if err := a.deliverResult(ctx, credentials, result); err != nil {
			return err
		}
	}
	return nil
}

func (a *Agent) deliverResult(ctx context.Context, credentials state.Credentials, result types.CommandResult) error {
	if err := a.client.SubmitResult(ctx, credentials, result); err != nil {
		return err
	}
	return a.store.MarkDelivered(result.CommandID)
}

func interruptedResult(command types.Command) types.CommandResult {
	return failedResult(command, "agent restarted while command status was indeterminate; command was not re-executed")
}

func failedResult(command types.Command, message string) types.CommandResult {
	now := time.Now().UTC()
	return types.CommandResult{
		CommandID: command.ID, Type: command.Type, ExitCode: -1, Error: message,
		StartedAt: now, FinishedAt: now,
	}
}

func sleep(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
