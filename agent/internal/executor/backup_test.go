package executor

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"gatewaycontrol/agent/internal/backuphelper"
)

func TestBackupPayloadStrictValidation(t *testing.T) {
	valid := `{"backupId":"223e4567-e89b-12d3-a456-426614174001","stackId":"123e4567-e89b-12d3-a456-426614174000","projectName":"project","revision":1,"target":"local","stackPath":"123e4567-e89b-12d3-a456-426614174000","composePath":"123e4567-e89b-12d3-a456-426614174000/compose.yaml"}`
	if _, err := decodeStackBackupPayload(json.RawMessage(valid)); err != nil {
		t.Fatal(err)
	}
	if _, err := decodeStackBackupPayload(json.RawMessage(strings.TrimSuffix(valid, "}") + `,"delete":true}`)); err == nil {
		t.Fatal("expected unknown field rejection")
	}
}

func TestHelperUsesFixedHardenedDockerArguments(t *testing.T) {
	executor := newTestExecutor(t)
	runner := &logsScriptedRunner{run: func([]string) (runOutput, error) { return runOutput{exitCode: 0}, nil }}
	executor.runner = runner
	if err := executor.runHelper(context.Background(), "backup", "project_data", "/host/backups/stack/backup", "data.tar.gz"); err != nil {
		t.Fatal(err)
	}
	expected := []string{"run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER", "--cap-add", "CHOWN", "--pids-limit", "64", "--user", "0:0", "--entrypoint", "/usr/local/bin/gateway-backup-helper", "--mount", "type=volume,src=project_data,dst=/source,readonly", "--mount", "type=bind,src=/host/backups/stack/backup,dst=/backup", "example/gateway-agent:test", "backup", "data.tar.gz"}
	if len(runner.commands) != 1 || !reflect.DeepEqual(runner.commands[0].args, expected) {
		t.Fatalf("helper args = %#v", runner.commands)
	}
}

func TestNASRequiresRegularMarker(t *testing.T) {
	executor := newTestExecutor(t)
	if _, _, err := executor.backupRoots("nas"); err == nil {
		t.Fatal("expected missing NAS marker rejection")
	}
	if err := os.MkdirAll(executor.nasBackupRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(executor.nasBackupRoot, executor.nasMarker), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, _, err := executor.backupRoots("nas"); err == nil {
		t.Fatal("expected directory marker rejection")
	}
}

func TestRestartServicesStartsOnlyPreviouslyRunningContainers(t *testing.T) {
	executor := newTestExecutor(t)
	runner := &logsScriptedRunner{run: func([]string) (runOutput, error) { return runOutput{exitCode: 0}, nil }}
	executor.runner = runner
	base := []string{"compose", "--project-name", "project", "--file", "/stack/compose.yaml"}
	executor.restartServices(context.Background(), base, []string{"web", "worker"})
	expected := append(append([]string{}, base...), "start", "web", "worker")
	if len(runner.commands) != 1 || !reflect.DeepEqual(runner.commands[0].args, expected) {
		t.Fatalf("restart args = %#v", runner.commands)
	}
}

func TestPostgresRestoreIsAtomicAndStopsOnError(t *testing.T) {
	executor := newTestExecutor(t)
	runner := &logsScriptedRunner{run: func(args []string) (runOutput, error) {
		if len(args) >= 2 && args[0] == "container" && args[1] == "ls" {
			return runOutput{stdout: "database-container\n", exitCode: 0}, nil
		}
		return runOutput{exitCode: 0}, nil
	}}
	executor.runner = runner
	database := manifestDatabase{Service: "postgres", Database: "app", User: "app", ArchiveName: "postgresql-postgres.dump"}
	if err := executor.restorePostgres(context.Background(), []string{"compose"}, "/backup", "project", database); err != nil {
		t.Fatal(err)
	}
	var restoreArgs []string
	for _, command := range runner.commands {
		if strings.Contains(strings.Join(command.args, " "), "pg_restore") {
			restoreArgs = command.args
		}
	}
	if !slicesContainInOrder(restoreArgs, "pg_restore", "--exit-on-error", "--single-transaction", "--clean") {
		t.Fatalf("pg_restore args = %#v", restoreArgs)
	}
}

func TestPostgresBackupStartsDatabaseAfterStackStopWindowAndStopsItBeforeReturning(t *testing.T) {
	executor := newTestExecutor(t)
	destination := t.TempDir()
	runner := &logsScriptedRunner{run: func(args []string) (runOutput, error) {
		if len(args) >= 2 && args[0] == "container" && args[1] == "ls" {
			return runOutput{stdout: "database-container\n", exitCode: 0}, nil
		}
		if len(args) == 4 && args[0] == "container" && args[1] == "cp" {
			if err := os.WriteFile(args[3], []byte("custom dump"), 0o600); err != nil {
				return runOutput{}, err
			}
		}
		return runOutput{exitCode: 0}, nil
	}}
	executor.runner = runner
	base := []string{"compose", "--project-name", "project", "--file", "/stack/compose.yaml"}
	config := postgresBackupConfig{Service: "postgres", Database: "app", User: "app"}
	if _, err := executor.backupPostgres(context.Background(), base, "223e4567-e89b-12d3-a456-426614174001", "project", destination, config); err != nil {
		t.Fatal(err)
	}
	start, dump, stop := -1, -1, -1
	for index, command := range runner.commands {
		joined := strings.Join(command.args, " ")
		if strings.HasSuffix(joined, "start postgres") { start = index }
		if strings.Contains(joined, " pg_dump ") { dump = index }
		if strings.HasSuffix(joined, "stop postgres") { stop = index }
	}
	if start < 0 || dump <= start || stop <= dump {
		t.Fatalf("PostgreSQL backup command order is unsafe: %#v", runner.commands)
	}
}

func slicesContainInOrder(values []string, expected ...string) bool {
	position := 0
	for _, value := range values {
		if position < len(expected) && value == expected[position] {
			position++
		}
	}
	return position == len(expected)
}

func TestManifestValidatesIdentityAndChecksum(t *testing.T) {
	directory := t.TempDir()
	source := t.TempDir()
	if err := os.WriteFile(filepath.Join(source, "data"), []byte("archive bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := backuphelper.Run("backup", source, directory, "data.tar.gz"); err != nil {
		t.Fatal(err)
	}
	size, checksum, _ := checksumRegularFile(filepath.Join(directory, "data.tar.gz"))
	manifest := backupManifest{Version: 1, BackupID: "223e4567-e89b-12d3-a456-426614174001", StackID: "123e4567-e89b-12d3-a456-426614174000", ProjectName: "project", Revision: 2, Target: "local", CreatedAt: time.Now().UTC(), Volumes: []manifestVolume{{LogicalName: "data", DockerName: "project_data", ArchiveName: "data.tar.gz", SizeBytes: size, SHA256: checksum}}}
	contents, _ := json.Marshal(manifest)
	if err := os.WriteFile(filepath.Join(directory, "manifest.json"), contents, 0o600); err != nil {
		t.Fatal(err)
	}
	payload := stackRestorePayload{RestoreID: "323e4567-e89b-12d3-a456-426614174002", BackupID: manifest.BackupID, StackID: manifest.StackID, ProjectName: manifest.ProjectName, Revision: 2, Target: "local"}
	if _, err := loadAndValidateManifest(directory, payload); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "data.tar.gz"), []byte("tampered"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadAndValidateManifest(directory, payload); err == nil {
		t.Fatal("expected checksum mismatch rejection")
	}
}
