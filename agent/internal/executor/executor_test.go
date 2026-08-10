package executor

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"gatewaycontrol/agent/internal/types"
)

func TestExecutePingWithoutSubprocess(t *testing.T) {
	executor := newTestExecutor(t)
	result := executor.Execute(context.Background(), types.Command{ID: "1", Type: "ping"})
	if !result.Success || result.Stdout != "pong" || result.ExitCode != 0 {
		t.Fatalf("result = %#v", result)
	}
}

func TestExecuteRejectsUnknownCommand(t *testing.T) {
	executor := newTestExecutor(t)
	result := executor.Execute(context.Background(), types.Command{ID: "1", Type: "shell"})
	if result.Success || !strings.Contains(result.Error, "not allowed") {
		t.Fatalf("result = %#v", result)
	}
}

func TestComposePathRejectsTraversal(t *testing.T) {
	executor := newTestExecutor(t)
	if _, err := executor.composePath("../compose.yml"); err == nil {
		t.Fatal("expected traversal to be rejected")
	}
	if _, err := executor.composePath(filepath.Join(string(filepath.Separator), "compose.yml")); err == nil {
		t.Fatal("expected absolute path to be rejected")
	}
}

func TestComposePathAcceptsRegularFileUnderRoot(t *testing.T) {
	root := t.TempDir()
	stackDirectory := filepath.Join(root, "stack-1")
	if err := os.Mkdir(stackDirectory, 0o755); err != nil {
		t.Fatal(err)
	}
	composeFile := filepath.Join(stackDirectory, "compose.yml")
	if err := os.WriteFile(composeFile, []byte("services: {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	executor, err := New(testOptions(t, root))
	if err != nil {
		t.Fatal(err)
	}
	actual, err := executor.composePath(filepath.Join("stack-1", "compose.yml"))
	if err != nil {
		t.Fatal(err)
	}
	if actual != composeFile {
		t.Fatalf("compose path = %q", actual)
	}
}

func TestComposePathRejectsSymlinkOutsideRoot(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation commonly requires elevated Windows privileges")
	}
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "compose.yml")
	if err := os.WriteFile(outside, []byte("services: {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "compose.yml")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	executor, err := New(testOptions(t, root))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := executor.composePath("compose.yml"); err == nil {
		t.Fatal("expected external symlink to be rejected")
	}
}

func TestDecodeComposePayloadRejectsInvalidIdentifiersAndUnknownFields(t *testing.T) {
	invalid := []string{
		`{"stack":"../bad","project":"project","compose_path":"compose.yml"}`,
		`{"stack":"stack","project":"bad project","compose_path":"compose.yml"}`,
		`{"stack":"stack","project":"project","compose_path":"compose.yml","args":["--privileged"]}`,
	}
	for _, value := range invalid {
		if _, err := decodeComposePayload(json.RawMessage(value)); err == nil {
			t.Fatalf("expected payload %s to be rejected", value)
		}
	}
}

func TestRedactMasksKnownAndPatternSecrets(t *testing.T) {
	executor := newTestExecutor(t)
	executor.secrets = []string{"known-credential"}
	redacted := executor.redact("token=abc password: value Authorization: Bearer xyz known-credential")
	for _, secret := range []string{"abc", "value", "xyz", "known-credential"} {
		if strings.Contains(redacted, secret) {
			t.Fatalf("redacted output still contains %q: %s", secret, redacted)
		}
	}
}

func TestRedactMasksStructuredCredentialCorpusWithoutMaskingHarmlessOutput(t *testing.T) {
	executor := newTestExecutor(t)
	privateKey := "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----"
	input := `{"token":"json-token","password":"quoted password","api_key":"api-value"} DATABASE_URL=postgresql://user:pass@example.com/db CLOUDFLARE_API_TOKEN=` + strings.Repeat("A", 45) + ` TELEGRAM_BOT_TOKEN=123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef Authorization: Bearer abc.def eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.signature` + "\n" + privateKey + "\nstatus=healthy secret_count=0"
	redacted := executor.redact(input)
	for _, secret := range []string{"json-token", "quoted password", "api-value", "pass@example", "abc.def", "eyJhbGci", "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef", strings.Repeat("A", 45), "private-material"} {
		if strings.Contains(redacted, secret) {
			t.Fatalf("redacted output still contains %q: %s", secret, redacted)
		}
	}
	if !strings.Contains(redacted, "status=healthy") || !strings.Contains(redacted, "secret_count=0") {
		t.Fatalf("harmless output was over-redacted: %s", redacted)
	}
}

func TestLimitedBufferCapsOutput(t *testing.T) {
	buffer := newLimitedBuffer(4)
	written, err := buffer.Write([]byte("123456"))
	if err != nil || written != 6 || buffer.String() != "1234" || !buffer.truncated {
		t.Fatalf("written=%d err=%v output=%q truncated=%v", written, err, buffer.String(), buffer.truncated)
	}
}

func newTestExecutor(t *testing.T) *Executor {
	t.Helper()
	executor, err := New(testOptions(t, t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	return executor
}

func testOptions(t *testing.T, stacksRoot string) Options {
	t.Helper()
	return Options{
		StacksRoot: stacksRoot, StateDir: t.TempDir(), StateVolume: "gateway-agent-state",
		HostStacksRoot: t.TempDir(), CloudflaredImage: "cloudflare/cloudflared:2026.7.3",
		LocalBackupRoot: t.TempDir(), HostLocalBackupRoot: t.TempDir(), NASBackupRoot: t.TempDir(), HostNASBackupRoot: t.TempDir(),
		NASMarker: ".gateway-control-nas", AgentImage: "example/gateway-agent:test", BackupTimeout: time.Second,
		EdgeNetwork: "gateway-control-edge", TraefikDynamicRoot: t.TempDir(), HostProcRoot: "/proc",
		TraefikDynamicVolume: "gateway-traefik-dynamic",
		Timeout:              time.Second, InfoTimeout: time.Second, MaxOutput: 1024,
	}
}
