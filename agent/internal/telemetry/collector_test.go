package telemetry

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"gatewaycontrol/agent/internal/types"
)

type fakeRunner struct {
	name string
	args []string
	out  []byte
}

func (runner *fakeRunner) Run(_ context.Context, name string, args ...string) ([]byte, error) {
	runner.name, runner.args = name, args
	return runner.out, nil
}

func TestCollectorReadsProcAndUsesFixedDockerFormat(t *testing.T) {
	root := t.TempDir()
	for name, contents := range map[string]string{
		"uptime":  "123.5 1\n",
		"loadavg": "0.10 0.20 0.30 1/10 2\n",
		"meminfo": "MemTotal: 1000 kB\nMemAvailable: 400 kB\n",
	} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	runner := &fakeRunner{out: []byte("project\tweb\trunning\tUp 2 minutes (healthy)\nproject\tworker\texited\tExited (0)\nproject\tproxy\trunning\tUp 2 minutes\n")}
	collector := &Collector{procRoot: root, runner: runner}
	snapshot, err := collector.Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Node.MemoryTotalBytes != 1000*1024 || len(snapshot.Services) != 3 || snapshot.Services[0].Status != "healthy" || snapshot.Services[1].Status != "completed" || snapshot.Services[2].Status != "running" {
		t.Fatalf("snapshot = %#v", snapshot)
	}
	expected := []string{"ps", "--all", "--format", "{{.Label \"com.docker.compose.project\"}}\t{{.Label \"com.docker.compose.service\"}}\t{{.State}}\t{{.Status}}"}
	if runner.name != "docker" || !reflect.DeepEqual(runner.args, expected) {
		t.Fatalf("command = %s %#v", runner.name, runner.args)
	}
}

func TestNormalizeStatusDistinguishesSuccessfulAndFailedExits(t *testing.T) {
	if status := normalizeStatus("exited", "Exited (0) 2 minutes ago"); status != "completed" {
		t.Fatalf("successful exit status = %q", status)
	}
	if status := normalizeStatus("exited", "Exited (1) 2 minutes ago"); status != "stopped" {
		t.Fatalf("failed exit status = %q", status)
	}
	if status := normalizeStatus("running", "Up 2 minutes"); status != "running" {
		t.Fatalf("unhealthchecked running status = %q", status)
	}
}

func TestCollectorAggregatesReplicasByExactProjectAndServiceIdentity(t *testing.T) {
	runner := &fakeRunner{out: []byte("alpha_beta\tweb\trunning\tUp (healthy)\nalpha_beta\tweb\texited\tExited (0)\nalpha\tbeta_web\trunning\tUp (unhealthy)\n")}
	collector := &Collector{runner: runner}
	services, err := collector.collectServices(context.Background())
	if err != nil || len(services) != 2 {
		t.Fatalf("services=%#v err=%v", services, err)
	}
	if services[0].Name != "alpha_beta/web" || services[0].Total != 2 || services[0].Running != 1 || services[0].Healthy != 1 || services[0].Completed != 1 || services[0].Status != "healthy" {
		t.Fatalf("aggregated service = %#v", services[0])
	}
	if services[1].Name != "alpha/beta_web" || services[1].Status != "unhealthy" {
		t.Fatalf("distinct service = %#v", services[1])
	}
}

func TestAggregateStatusUsesRuntimePrecedence(t *testing.T) {
	tests := map[string]struct {
		service types.TelemetryService
		want    string
	}{
		"unhealthy": {types.TelemetryService{Total: 3, Running: 2, Healthy: 1, Unhealthy: 1, Stopped: 1}, "unhealthy"},
		"starting": {types.TelemetryService{Total: 2, Running: 2, Healthy: 1, Starting: 1}, "starting"},
		"stopped": {types.TelemetryService{Total: 2, Running: 1, Healthy: 1, Stopped: 1}, "stopped"},
		"completed": {types.TelemetryService{Total: 2, Completed: 2}, "completed"},
		"running": {types.TelemetryService{Total: 2, Running: 1, Completed: 1}, "running"},
		"healthy with completed": {types.TelemetryService{Total: 2, Running: 1, Healthy: 1, Completed: 1}, "healthy"},
		"unknown": {types.TelemetryService{Total: 2, Running: 1, Healthy: 1, Completed: 2}, "unknown"},
	}
	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			if got := aggregateStatus(test.service); got != test.want {
				t.Fatalf("status = %q, want %q", got, test.want)
			}
		})
	}
}

func TestComposeProjectAndServiceValidatorsMatchServerContracts(t *testing.T) {
	for _, project := range []string{"gateway-control", "api_2"} {
		if !validComposeProjectName(project) {
			t.Fatalf("valid project %q was rejected", project)
		}
	}
	for _, project := range []string{"Gateway", "api.web"} {
		if validComposeProjectName(project) {
			t.Fatalf("invalid project %q was accepted", project)
		}
	}
	for _, service := range []string{"Web.API", "worker-v2", "QUEUE_1"} {
		if !validComposeServiceName(service) {
			t.Fatalf("valid service %q was rejected", service)
		}
	}
}
