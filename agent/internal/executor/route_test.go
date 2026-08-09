package executor

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"gatewaycontrol/agent/internal/types"
)

const testRouteID = "423e4567-e89b-12d3-a456-426614174003"

func TestRouteSyncGeneratesTunnelConfiguration(t *testing.T) {
	executor := newTestExecutor(t)
	result := executor.Execute(context.Background(), routeCommand("tunnel", true, testRouteID, nil))
	if !result.Success {
		t.Fatalf("result = %#v", result)
	}
	configuration := readRouteConfiguration(t, executor, testRouteID)
	info, err := os.Stat(filepath.Join(executor.traefikDynamicRoot, testRouteID+".yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o644 {
		t.Fatalf("route file mode = %v", info.Mode().Perm())
	}
	if len(configuration.HTTP.Routers) != 1 || len(configuration.HTTP.Middlewares) != 0 {
		t.Fatalf("configuration = %#v", configuration)
	}
	for _, router := range configuration.HTTP.Routers {
		if len(router.EntryPoints) != 1 || router.EntryPoints[0] != "web" || router.TLS != nil {
			t.Fatalf("tunnel router = %#v", router)
		}
	}
	for _, service := range configuration.HTTP.Services {
		if len(service.LoadBalancer.Servers) != 1 || service.LoadBalancer.Servers[0].URL != "http://app:8080" {
			t.Fatalf("service = %#v", service)
		}
	}
}

func TestRouteSyncGeneratesPublicRedirectAndTLSConfiguration(t *testing.T) {
	executor := newTestExecutor(t)
	result := executor.Execute(context.Background(), routeCommand("public", true, testRouteID, nil))
	if !result.Success {
		t.Fatalf("result = %#v", result)
	}
	configuration := readRouteConfiguration(t, executor, testRouteID)
	if len(configuration.HTTP.Routers) != 2 || len(configuration.HTTP.Middlewares) != 1 {
		t.Fatalf("configuration = %#v", configuration)
	}
	foundWeb := false
	foundWebsecure := false
	for _, router := range configuration.HTTP.Routers {
		if router.EntryPoints[0] == "web" {
			foundWeb = len(router.Middlewares) == 1 && router.TLS == nil
		}
		if router.EntryPoints[0] == "websecure" {
			foundWebsecure = router.TLS != nil && router.TLS.CertificateResolver == "letsencrypt"
		}
	}
	if !foundWeb || !foundWebsecure {
		t.Fatalf("public routers = %#v", configuration.HTTP.Routers)
	}
	for _, middleware := range configuration.HTTP.Middlewares {
		if middleware.RedirectScheme == nil || middleware.RedirectScheme.Scheme != "https" || !middleware.RedirectScheme.Permanent {
			t.Fatalf("redirect middleware = %#v", middleware)
		}
	}
}

func TestRouteSyncDisableRemovesFileIdempotently(t *testing.T) {
	executor := newTestExecutor(t)
	if result := executor.Execute(context.Background(), routeCommand("tunnel", true, testRouteID, nil)); !result.Success {
		t.Fatalf("enable result = %#v", result)
	}
	for attempt := 0; attempt < 2; attempt++ {
		if result := executor.Execute(context.Background(), routeCommand("tunnel", false, testRouteID, nil)); !result.Success {
			t.Fatalf("disable result = %#v", result)
		}
	}
	path := filepath.Join(executor.traefikDynamicRoot, testRouteID+".yaml")
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("route file error = %v, want not exist", err)
	}
}

func TestRouteSyncRejectsTraversalUnknownFieldsAndInvalidBackends(t *testing.T) {
	executor := newTestExecutor(t)
	commands := []types.Command{
		routeCommand("tunnel", true, "../../route", nil),
		routeCommand("tunnel", true, testRouteID, map[string]any{"unknown": true}),
		routeCommand("tunnel", true, testRouteID, map[string]any{"backends": []string{"https://user:secret@example.com"}}),
		routeCommand("invalid", true, testRouteID, nil),
	}
	for _, command := range commands {
		if result := executor.Execute(context.Background(), command); result.Success {
			t.Fatalf("command unexpectedly succeeded: %#v", command)
		}
	}
}

func routeCommand(exposure string, enabled bool, routeID string, overrides map[string]any) types.Command {
	payload := map[string]any{
		"routeId": routeID, "name": "Application route", "hostname": "app.example.com",
		"exposure": exposure, "backends": []string{"http://app:8080"}, "enabled": enabled, "revision": 1,
	}
	for key, value := range overrides {
		payload[key] = value
	}
	encoded, _ := json.Marshal(payload)
	return types.Command{ID: "command", Type: "traefik.route.sync", Payload: encoded}
}

func readRouteConfiguration(t *testing.T, executor *Executor, routeID string) traefikDynamicConfiguration {
	t.Helper()
	contents, err := os.ReadFile(filepath.Join(executor.traefikDynamicRoot, routeID+".yaml"))
	if err != nil {
		t.Fatal(err)
	}
	var configuration traefikDynamicConfiguration
	if err := json.Unmarshal(contents, &configuration); err != nil {
		t.Fatal(err)
	}
	return configuration
}
