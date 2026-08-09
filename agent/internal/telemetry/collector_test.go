package telemetry

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"
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
	runner := &fakeRunner{out: []byte("project\tweb\trunning\tUp 2 minutes (healthy)\nproject\tworker\texited\tExited (0)\n")}
	collector := &Collector{procRoot: root, runner: runner}
	snapshot, err := collector.Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Node.MemoryTotalBytes != 1000*1024 || len(snapshot.Services) != 2 || snapshot.Services[0].Status != "healthy" || snapshot.Services[1].Status != "stopped" {
		t.Fatalf("snapshot = %#v", snapshot)
	}
	expected := []string{"ps", "--all", "--format", dockerServiceFormat}
	if runner.name != "docker" || !reflect.DeepEqual(runner.args, expected) {
		t.Fatalf("command = %s %#v", runner.name, runner.args)
	}
}
