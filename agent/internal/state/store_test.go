package state

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"gatewaycontrol/agent/internal/types"
)

func TestStorePersistsCredentialsAndCommandResult(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "state")
	store, err := Open(directory)
	if err != nil {
		t.Fatal(err)
	}
	credentials := Credentials{AgentID: "agent-id", APICredential: "raw-secret"}
	if err := store.SaveCredentials(credentials); err != nil {
		t.Fatal(err)
	}
	if err := store.MarkRunning("command-1"); err != nil {
		t.Fatal(err)
	}
	if err := store.MarkRunning("command-1"); err == nil {
		t.Fatal("expected duplicate running command to be rejected")
	}
	result := types.CommandResult{CommandID: "command-1", Type: "ping", Success: true, ExitCode: 0, Stdout: "output", Logs: "logs", StartedAt: time.Now(), FinishedAt: time.Now()}
	if err := store.SaveResult(result); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(directory)
	if err != nil {
		t.Fatal(err)
	}
	actualCredentials, found := reopened.Credentials()
	if !found || actualCredentials != credentials {
		t.Fatalf("credentials = %#v, found = %v", actualCredentials, found)
	}
	record, found := reopened.Command("command-1")
	if !found || record.Result == nil || !record.Result.Success {
		t.Fatalf("command record = %#v, found = %v", record, found)
	}
	if len(reopened.PendingResults()) != 1 {
		t.Fatal("expected undelivered result")
	}
	if err := reopened.MarkDelivered("command-1"); err != nil {
		t.Fatal(err)
	}
	if len(reopened.PendingResults()) != 0 {
		t.Fatal("expected delivered result not to remain pending")
	}
	record, found = reopened.Command("command-1")
	if !found || record.Result == nil || record.Result.Stdout != "" || record.Result.Stderr != "" || record.Result.Logs != "" {
		t.Fatalf("delivered tombstone = %#v, found = %v", record, found)
	}

	if runtime.GOOS != "windows" {
		info, err := os.Stat(filepath.Join(directory, "state.json"))
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("state permissions = %o", info.Mode().Perm())
		}
	}
}
