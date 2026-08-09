package agent

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"gatewaycontrol/agent/internal/state"
	"gatewaycontrol/agent/internal/types"
)

func TestProcessCommandsExecutesBatchSequentiallyAndDeduplicates(t *testing.T) {
	store, err := state.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	executor := &recordingExecutor{}
	client := &recordingClient{}
	agent := &Agent{
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		store:  store, client: client, executor: executor,
	}
	commands := []types.Command{
		{ID: "123e4567-e89b-12d3-a456-426614174000", Type: "ping"},
		{ID: "223e4567-e89b-12d3-a456-426614174001", Type: "ping"},
	}
	credentials := state.Credentials{AgentID: "agent-id", APICredential: "credential"}

	agent.processCommands(context.Background(), credentials, commands)
	assertIDs(t, executor.executed, []string{commands[0].ID, commands[1].ID})
	assertIDs(t, client.submitted, []string{commands[0].ID, commands[1].ID})

	agent.processCommands(context.Background(), credentials, commands)
	assertIDs(t, executor.executed, []string{commands[0].ID, commands[1].ID})
	assertIDs(t, client.submitted, []string{commands[0].ID, commands[1].ID, commands[0].ID, commands[1].ID})
}

func TestProcessCommandsContinuesBatchAndRetriesPersistedResult(t *testing.T) {
	store, err := state.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	executor := &recordingExecutor{}
	client := &failingOnceClient{}
	agent := &Agent{
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		store:  store, client: client, executor: executor,
	}
	commands := []types.Command{
		{ID: "123e4567-e89b-12d3-a456-426614174000", Type: "ping"},
		{ID: "223e4567-e89b-12d3-a456-426614174001", Type: "ping"},
	}
	credentials := state.Credentials{AgentID: "agent-id", APICredential: "credential"}

	agent.processCommands(context.Background(), credentials, commands)
	assertIDs(t, executor.executed, []string{commands[0].ID, commands[1].ID})
	if len(store.PendingResults()) != 1 {
		t.Fatalf("pending results = %d, want 1", len(store.PendingResults()))
	}
	if err := agent.deliverPending(context.Background(), credentials); err != nil {
		t.Fatal(err)
	}
	if len(store.PendingResults()) != 0 {
		t.Fatalf("pending results = %d, want 0", len(store.PendingResults()))
	}
	assertIDs(t, client.attempted, []string{commands[0].ID, commands[1].ID, commands[0].ID})
}

type recordingExecutor struct {
	executed []string
}

func (e *recordingExecutor) Execute(_ context.Context, command types.Command) types.CommandResult {
	e.executed = append(e.executed, command.ID)
	now := time.Now().UTC()
	return types.CommandResult{
		CommandID: command.ID, Type: command.Type, Success: true, ExitCode: 0,
		StartedAt: now, FinishedAt: now,
	}
}

func (e *recordingExecutor) DockerStatus(context.Context) types.DockerStatus {
	return types.DockerStatus{}
}

type recordingClient struct {
	submitted []string
}

type failingOnceClient struct {
	attempted []string
	failed    bool
}

func (c *failingOnceClient) Enroll(context.Context, string) (state.Credentials, error) {
	return state.Credentials{}, nil
}

func (c *failingOnceClient) Heartbeat(context.Context, state.Credentials, types.Heartbeat) error {
	return nil
}

func (c *failingOnceClient) Telemetry(context.Context, state.Credentials, types.Telemetry) error {
	return nil
}

func (c *failingOnceClient) Commands(context.Context, state.Credentials) ([]types.Command, error) {
	return nil, nil
}

func (c *failingOnceClient) SubmitResult(_ context.Context, _ state.Credentials, result types.CommandResult) error {
	c.attempted = append(c.attempted, result.CommandID)
	if !c.failed {
		c.failed = true
		return errors.New("temporary result delivery failure")
	}
	return nil
}

func (c *recordingClient) Enroll(context.Context, string) (state.Credentials, error) {
	return state.Credentials{}, nil
}

func (c *recordingClient) Heartbeat(context.Context, state.Credentials, types.Heartbeat) error {
	return nil
}

func (c *recordingClient) Telemetry(context.Context, state.Credentials, types.Telemetry) error {
	return nil
}

func (c *recordingClient) Commands(context.Context, state.Credentials) ([]types.Command, error) {
	return nil, nil
}

func (c *recordingClient) SubmitResult(_ context.Context, _ state.Credentials, result types.CommandResult) error {
	c.submitted = append(c.submitted, result.CommandID)
	return nil
}

func assertIDs(t *testing.T, actual, expected []string) {
	t.Helper()
	if len(actual) != len(expected) {
		t.Fatalf("IDs = %#v, want %#v", actual, expected)
	}
	for index := range expected {
		if actual[index] != expected[index] {
			t.Fatalf("IDs = %#v, want %#v", actual, expected)
		}
	}
}
