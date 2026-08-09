package types

import (
	"encoding/json"
	"time"
)

type Command struct {
	ID      string          `json:"id"`
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

type ComposePayload struct {
	Stack       string `json:"stack"`
	Project     string `json:"project"`
	ComposePath string `json:"compose_path"`
}

type CommandResult struct {
	CommandID  string    `json:"command_id"`
	Type       string    `json:"type"`
	Success    bool      `json:"success"`
	ExitCode   int       `json:"exit_code"`
	Stdout     string    `json:"stdout"`
	Stderr     string    `json:"stderr"`
	Error      string    `json:"error"`
	TimedOut   bool      `json:"timed_out"`
	Truncated  bool      `json:"truncated"`
	StartedAt  time.Time `json:"started_at"`
	FinishedAt time.Time `json:"finished_at"`
	Logs       string    `json:"logs,omitempty"`
	BackupID   string    `json:"backupId,omitempty"`
	RestoreID  string    `json:"restoreId,omitempty"`
	StackID    string    `json:"stackId,omitempty"`
	Target     string    `json:"target,omitempty"`
	Revision   int64     `json:"revision,omitempty"`
	SizeBytes  int64     `json:"sizeBytes,omitempty"`
	FileCount  int       `json:"fileCount,omitempty"`
	Checksum   string    `json:"checksum,omitempty"`
}

type DockerStatus struct {
	CLIAvailable    bool   `json:"cli_available"`
	DaemonAvailable bool   `json:"daemon_available"`
	Version         string `json:"version,omitempty"`
}

type Heartbeat struct {
	Hostname     string       `json:"hostname"`
	OS           string       `json:"os"`
	Architecture string       `json:"architecture"`
	AgentVersion string       `json:"agent_version"`
	Docker       DockerStatus `json:"docker"`
}

type Telemetry struct {
	ObservedAt time.Time          `json:"observedAt"`
	Node       TelemetryNode      `json:"node"`
	Services   []TelemetryService `json:"services"`
}

type TelemetryNode struct {
	UptimeSeconds        float64 `json:"uptimeSeconds"`
	Load1                float64 `json:"load1"`
	Load5                float64 `json:"load5"`
	Load15               float64 `json:"load15"`
	MemoryTotalBytes     uint64  `json:"memoryTotalBytes"`
	MemoryAvailableBytes uint64  `json:"memoryAvailableBytes"`
}

type TelemetryService struct {
	Name        string `json:"name"`
	Status      string `json:"status"`
	ProjectName string `json:"projectName,omitempty"`
	ServiceName string `json:"serviceName,omitempty"`
}
