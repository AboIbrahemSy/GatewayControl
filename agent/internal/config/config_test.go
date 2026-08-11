package config

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestLoadRequiresHTTPSByDefault(t *testing.T) {
	setRequiredEnvironment(t)
	t.Setenv("GATEWAY_CONTROL_URL", "http://control.example.test")

	_, err := Load()
	if err == nil {
		t.Fatal("expected insecure HTTP URL to be rejected")
	}
}

func TestLoadAllowsExplicitDevelopmentHTTP(t *testing.T) {
	setRequiredEnvironment(t)
	t.Setenv("GATEWAY_CONTROL_URL", "http://127.0.0.1:8080/base/")
	t.Setenv("GATEWAY_ALLOW_INSECURE_HTTP", "true")

	config, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if config.ControlURL.String() != "http://127.0.0.1:8080/base" {
		t.Fatalf("ControlURL = %q", config.ControlURL.String())
	}
}

func TestLoadReadsSecretFromFile(t *testing.T) {
	setRequiredEnvironment(t)
	t.Setenv("GATEWAY_CONTROL_URL", "https://control.example.test")
	if err := os.Unsetenv("GATEWAY_ENROLLMENT_TOKEN"); err != nil {
		t.Fatal(err)
	}
	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte("one-time-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GATEWAY_ENROLLMENT_TOKEN_FILE", tokenFile)

	config, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if config.EnrollmentToken != "one-time-token" {
		t.Fatalf("EnrollmentToken = %q", config.EnrollmentToken)
	}
}

func TestLoadAcceptsCanonicalEnrollmentTokenEnvironmentName(t *testing.T) {
	setRequiredEnvironment(t)
	t.Setenv("GATEWAY_CONTROL_URL", "https://control.example.test")
	t.Setenv("GATEWAY_ENROLLMENT_TOKEN", "canonical-token")

	config, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if config.EnrollmentToken != "canonical-token" {
		t.Fatalf("EnrollmentToken = %q", config.EnrollmentToken)
	}
}

func TestLoadAcceptsServerGeneratedEnrollmentTokenAlias(t *testing.T) {
	setRequiredEnvironment(t)
	t.Setenv("GATEWAY_CONTROL_URL", "https://control.example.test")
	if err := os.Unsetenv("GATEWAY_ENROLLMENT_TOKEN"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GATEWAY_CONTROL_ENROLLMENT_TOKEN", "generated-command-token")

	config, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if config.EnrollmentToken != "generated-command-token" {
		t.Fatalf("EnrollmentToken = %q", config.EnrollmentToken)
	}
}

func TestLoadRejectsDirectAndFileValueTogether(t *testing.T) {
	setRequiredEnvironment(t)
	t.Setenv("GATEWAY_CONTROL_URL", "https://control.example.test")
	t.Setenv("GATEWAY_AGENT_NAME", "agent-01")
	t.Setenv("GATEWAY_AGENT_NAME_FILE", "unused")

	_, err := Load()
	if err == nil {
		t.Fatal("expected mutually exclusive values to be rejected")
	}
}

func TestLoadUsesPinnedCloudflaredAndEdgeNetworkDefaults(t *testing.T) {
	setRequiredEnvironment(t)
	t.Setenv("GATEWAY_CONTROL_URL", "https://control.example.test")

	config, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if config.CloudflaredImage != "cloudflare/cloudflared:2026.7.3" {
		t.Fatalf("CloudflaredImage = %q", config.CloudflaredImage)
	}
	if config.EdgeNetwork != "gateway-control-edge" {
		t.Fatalf("EdgeNetwork = %q", config.EdgeNetwork)
	}
	if config.TraefikDynamicRoot == "" {
		t.Fatal("TraefikDynamicRoot is empty")
	}
}

func TestLoadValidatesDockerConnectorSettings(t *testing.T) {
	tests := []struct {
		name  string
		key   string
		value string
	}{
		{name: "invalid state volume", key: "GATEWAY_STATE_VOLUME", value: "../volume"},
		{name: "relative host stacks root", key: "GATEWAY_HOST_STACKS_ROOT", value: "relative/stacks"},
		{name: "unpinned image", key: "GATEWAY_CLOUDFLARED_IMAGE", value: "cloudflare/cloudflared"},
		{name: "latest image", key: "GATEWAY_CLOUDFLARED_IMAGE", value: "cloudflare/cloudflared:latest"},
		{name: "invalid edge network", key: "GATEWAY_EDGE_NETWORK", value: "bad/network"},
		{name: "invalid Traefik volume", key: "GATEWAY_TRAEFIK_DYNAMIC_VOLUME", value: "../volume"},
		{name: "unpinned agent image", key: "GATEWAY_AGENT_IMAGE", value: "example/gateway-agent"},
		{name: "latest agent image", key: "GATEWAY_AGENT_IMAGE", value: "example/gateway-agent:latest"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			setRequiredEnvironment(t)
			t.Setenv("GATEWAY_CONTROL_URL", "https://control.example.test")
			t.Setenv(test.key, test.value)
			if _, err := Load(); err == nil {
				t.Fatalf("expected %s to be rejected", test.value)
			}
		})
	}
}

func TestLoadEnforcesMinimumMetricsInterval(t *testing.T) {
	setRequiredEnvironment(t)
	t.Setenv("GATEWAY_CONTROL_URL", "https://control.example.test")
	t.Setenv("GATEWAY_METRICS_INTERVAL", "9s")
	if _, err := Load(); err == nil {
		t.Fatal("expected metrics interval below ten seconds to be rejected")
	}
}

func TestLoadBuildsCanonicalBoundedProtectedProjects(t *testing.T) {
	setRequiredEnvironment(t)
	t.Setenv("GATEWAY_CONTROL_URL", "https://control.example.test")
	t.Setenv("GATEWAY_PROTECTED_PROJECTS", "critical_api,gateway-control,critical_api")

	config, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(config.ProtectedProjects, []string{"gateway-control", "critical_api"}) {
		t.Fatalf("ProtectedProjects = %#v", config.ProtectedProjects)
	}

	projects := make([]string, 20)
	for index := range projects {
		projects[index] = fmt.Sprintf("project_%d", index)
	}
	t.Setenv("GATEWAY_PROTECTED_PROJECTS", strings.Join(projects, ","))
	if _, err := Load(); err == nil {
		t.Fatal("expected more than 20 total protected projects to be rejected")
	}
}

func setRequiredEnvironment(t *testing.T) {
	t.Helper()
	for _, key := range []string{
		"GATEWAY_CONTROL_URL", "GATEWAY_CONTROL_URL_FILE", "GATEWAY_ENROLLMENT_TOKEN", "GATEWAY_ENROLLMENT_TOKEN_FILE",
		"GATEWAY_AGENT_NAME", "GATEWAY_AGENT_NAME_FILE", "GATEWAY_STATE_DIR", "GATEWAY_STATE_DIR_FILE",
		"GATEWAY_STACKS_ROOT", "GATEWAY_STACKS_ROOT_FILE", "GATEWAY_ALLOW_INSECURE_HTTP", "GATEWAY_ALLOW_INSECURE_HTTP_FILE",
		"GATEWAY_CONTROL_ENROLLMENT_TOKEN", "GATEWAY_CONTROL_ENROLLMENT_TOKEN_FILE",
		"GATEWAY_STATE_VOLUME", "GATEWAY_STATE_VOLUME_FILE", "GATEWAY_HOST_STACKS_ROOT", "GATEWAY_HOST_STACKS_ROOT_FILE",
		"GATEWAY_DEPLOYMENTS_ROOT", "GATEWAY_DEPLOYMENTS_ROOT_FILE", "GATEWAY_HOST_DEPLOYMENTS_ROOT", "GATEWAY_HOST_DEPLOYMENTS_ROOT_FILE",
		"GATEWAY_CLOUDFLARED_IMAGE", "GATEWAY_CLOUDFLARED_IMAGE_FILE", "GATEWAY_EDGE_NETWORK", "GATEWAY_EDGE_NETWORK_FILE",
		"GATEWAY_TRAEFIK_DYNAMIC_ROOT", "GATEWAY_TRAEFIK_DYNAMIC_ROOT_FILE",
		"GATEWAY_TRAEFIK_DYNAMIC_VOLUME", "GATEWAY_TRAEFIK_DYNAMIC_VOLUME_FILE",
		"GATEWAY_AGENT_IMAGE", "GATEWAY_AGENT_IMAGE_FILE", "GATEWAY_HOST_PROC_ROOT", "GATEWAY_HOST_PROC_ROOT_FILE",
		"GATEWAY_LOCAL_BACKUP_ROOT", "GATEWAY_LOCAL_BACKUP_ROOT_FILE", "GATEWAY_HOST_LOCAL_BACKUP_ROOT", "GATEWAY_HOST_LOCAL_BACKUP_ROOT_FILE",
		"GATEWAY_NAS_BACKUP_ROOT", "GATEWAY_NAS_BACKUP_ROOT_FILE", "GATEWAY_HOST_NAS_BACKUP_ROOT", "GATEWAY_HOST_NAS_BACKUP_ROOT_FILE",
		"GATEWAY_NAS_MARKER", "GATEWAY_NAS_MARKER_FILE", "GATEWAY_METRICS_INTERVAL", "GATEWAY_METRICS_INTERVAL_FILE",
		"GATEWAY_BACKUP_TIMEOUT", "GATEWAY_BACKUP_TIMEOUT_FILE",
		"GATEWAY_PROTECTED_PROJECTS", "GATEWAY_PROTECTED_PROJECTS_FILE",
	} {
		t.Setenv(key, "")
		if len(key) > 5 && key[len(key)-5:] == "_FILE" {
			if err := os.Unsetenv(key); err != nil {
				t.Fatal(err)
			}
		}
	}
	t.Setenv("GATEWAY_AGENT_NAME", "agent-01")
	t.Setenv("GATEWAY_STATE_DIR", t.TempDir())
	t.Setenv("GATEWAY_STACKS_ROOT", t.TempDir())
	t.Setenv("GATEWAY_STATE_VOLUME", "gateway-agent-state")
	t.Setenv("GATEWAY_HOST_STACKS_ROOT", t.TempDir())
	t.Setenv("GATEWAY_DEPLOYMENTS_ROOT", t.TempDir())
	t.Setenv("GATEWAY_HOST_DEPLOYMENTS_ROOT", t.TempDir())
	t.Setenv("GATEWAY_TRAEFIK_DYNAMIC_VOLUME", "gateway-traefik-dynamic")
	t.Setenv("GATEWAY_AGENT_IMAGE", "example/gateway-agent:test")
	t.Setenv("GATEWAY_HOST_PROC_ROOT", t.TempDir())
	t.Setenv("GATEWAY_LOCAL_BACKUP_ROOT", t.TempDir())
	t.Setenv("GATEWAY_HOST_LOCAL_BACKUP_ROOT", t.TempDir())
	t.Setenv("GATEWAY_NAS_BACKUP_ROOT", t.TempDir())
	t.Setenv("GATEWAY_HOST_NAS_BACKUP_ROOT", t.TempDir())
}
