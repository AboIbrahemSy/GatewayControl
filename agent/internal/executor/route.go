package executor

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"gatewaycontrol/agent/internal/types"
)

const maximumRoutePayloadBytes = 256 * 1024

var hostnameLabelPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)

type routeSyncPayload struct {
	RouteID  string   `json:"routeId"`
	Name     string   `json:"name"`
	Hostname string   `json:"hostname"`
	Exposure string   `json:"exposure"`
	Backends []string `json:"backends"`
	Enabled  *bool    `json:"enabled"`
	Revision *int64   `json:"revision"`
}

type traefikDynamicConfiguration struct {
	HTTP traefikHTTPConfiguration `json:"http"`
}

type traefikHTTPConfiguration struct {
	Routers     map[string]traefikRouter     `json:"routers"`
	Services    map[string]traefikService    `json:"services"`
	Middlewares map[string]traefikMiddleware `json:"middlewares,omitempty"`
}

type traefikRouter struct {
	EntryPoints []string    `json:"entryPoints"`
	Rule        string      `json:"rule"`
	Service     string      `json:"service"`
	Middlewares []string    `json:"middlewares,omitempty"`
	TLS         *traefikTLS `json:"tls,omitempty"`
}

type traefikTLS struct {
	CertificateResolver string `json:"certResolver"`
}

type traefikService struct {
	LoadBalancer traefikLoadBalancer `json:"loadBalancer"`
}

type traefikLoadBalancer struct {
	Servers []traefikServer `json:"servers"`
}

type traefikServer struct {
	URL string `json:"url"`
}

type traefikMiddleware struct {
	RedirectScheme *traefikRedirectScheme `json:"redirectScheme,omitempty"`
}

type traefikRedirectScheme struct {
	Scheme    string `json:"scheme"`
	Permanent bool   `json:"permanent"`
}

func (e *Executor) executeRouteSync(ctx context.Context, result types.CommandResult, raw json.RawMessage) types.CommandResult {
	payload, err := decodeRouteSyncPayload(raw)
	if err != nil {
		return safeSyncFailure(result, "route payload validation failed")
	}
	directory, err := secureSubdirectory(e.traefikDynamicRoot)
	if err != nil {
		return safeSyncFailure(result, "route configuration storage failed")
	}
	path := filepath.Join(directory, strings.ToLower(payload.RouteID)+".yaml")
	if !*payload.Enabled {
		if err := removeFileAndSync(path); err != nil {
			return safeSyncFailure(result, "route configuration removal failed")
		}
		return safeSyncSuccess(result, "Traefik route disabled")
	}
	if !e.probeRouteBackends(ctx, payload.Backends) {
		result = safeSyncFailure(result, "backend probe failed")
		result.Code = "backend_probe_failed"
		return result
	}
	configuration := buildTraefikConfiguration(payload)
	contents, err := json.Marshal(configuration)
	if err != nil {
		return safeSyncFailure(result, "route configuration generation failed")
	}
	if err := writeFileAtomically(path, contents, 0o644); err != nil {
		return safeSyncFailure(result, "route configuration storage failed")
	}
	return safeSyncSuccess(result, "Traefik route synchronized")
}

func (e *Executor) probeRouteBackends(parent context.Context, backends []string) bool {
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	results := make(chan bool, len(backends))
	for _, backend := range backends {
		go func(target string) {
			request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
			if err != nil {
				results <- false
				return
			}
			request.Header.Set("Range", "bytes=0-0")
			response, err := e.httpClient.Do(request)
			if err != nil {
				results <- false
				return
			}
			_ = response.Body.Close()
			results <- response.StatusCode >= 200 && response.StatusCode < 400
		}(backend)
	}
	for range backends {
		select {
		case reachable := <-results:
			if !reachable {
				return false
			}
		case <-ctx.Done():
			return false
		}
	}
	return true
}

func decodeRouteSyncPayload(raw json.RawMessage) (routeSyncPayload, error) {
	var payload routeSyncPayload
	if len(raw) == 0 || len(raw) > maximumRoutePayloadBytes {
		return payload, errors.New("route sync payload is too large")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		return payload, fmt.Errorf("invalid route sync payload: %w", err)
	}
	if decoder.Decode(&struct{}{}) == nil {
		return payload, errors.New("route sync payload contains trailing data")
	}
	if !connectorUUIDPattern.MatchString(payload.RouteID) {
		return payload, errors.New("routeId must be a valid UUID")
	}
	if !validDisplayName(payload.Name, 120) {
		return payload, errors.New("name must contain 1 to 120 valid, non-control characters")
	}
	payload.Hostname = strings.ToLower(payload.Hostname)
	if !validHostname(payload.Hostname) {
		return payload, errors.New("hostname must be a valid DNS hostname")
	}
	if payload.Exposure != "tunnel" && payload.Exposure != "public" {
		return payload, errors.New("exposure must be tunnel or public")
	}
	if payload.Enabled == nil {
		return payload, errors.New("enabled must be a boolean")
	}
	if payload.Revision == nil || *payload.Revision < 1 {
		return payload, errors.New("revision must be a positive integer")
	}
	if len(payload.Backends) < 1 || len(payload.Backends) > 20 {
		return payload, errors.New("backends must contain 1 to 20 URLs")
	}
	seenBackends := make(map[string]struct{}, len(payload.Backends))
	for _, backend := range payload.Backends {
		if err := validateBackendURL(backend); err != nil {
			return payload, err
		}
		if _, exists := seenBackends[backend]; exists {
			return payload, errors.New("backends must not contain duplicate URLs")
		}
		seenBackends[backend] = struct{}{}
	}
	return payload, nil
}

func validHostname(hostname string) bool {
	if len(hostname) < 1 || len(hostname) > 253 || !utf8.ValidString(hostname) || net.ParseIP(hostname) != nil {
		return false
	}
	for _, label := range strings.Split(hostname, ".") {
		if !hostnameLabelPattern.MatchString(label) {
			return false
		}
	}
	return true
}

func validateBackendURL(value string) error {
	if len(value) < 8 || len(value) > 2048 || strings.TrimSpace(value) != value || !utf8.ValidString(value) {
		return errors.New("backend URL is invalid")
	}
	parsed, err := url.Parse(value)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" ||
		parsed.User != nil || parsed.Fragment != "" || parsed.RawQuery != "" {
		return errors.New("backend URL must be an absolute HTTP or HTTPS URL without credentials, query, or fragment")
	}
	return nil
}

func buildTraefikConfiguration(payload routeSyncPayload) traefikDynamicConfiguration {
	identifier := "gc-route-" + strings.ReplaceAll(strings.ToLower(payload.RouteID), "-", "")
	serviceName := identifier + "-service"
	servers := make([]traefikServer, 0, len(payload.Backends))
	for _, backend := range payload.Backends {
		servers = append(servers, traefikServer{URL: backend})
	}
	httpConfiguration := traefikHTTPConfiguration{
		Routers: make(map[string]traefikRouter),
		Services: map[string]traefikService{
			serviceName: {LoadBalancer: traefikLoadBalancer{Servers: servers}},
		},
	}
	rule := "Host(`" + payload.Hostname + "`)"
	if payload.Exposure == "tunnel" {
		httpConfiguration.Routers[identifier+"-tunnel"] = traefikRouter{
			EntryPoints: []string{"web"}, Rule: rule, Service: serviceName,
		}
		return traefikDynamicConfiguration{HTTP: httpConfiguration}
	}
	redirectName := identifier + "-redirect"
	httpConfiguration.Middlewares = map[string]traefikMiddleware{
		redirectName: {RedirectScheme: &traefikRedirectScheme{Scheme: "https", Permanent: true}},
	}
	httpConfiguration.Routers[identifier+"-web"] = traefikRouter{
		EntryPoints: []string{"web"}, Rule: rule, Service: serviceName, Middlewares: []string{redirectName},
	}
	httpConfiguration.Routers[identifier+"-websecure"] = traefikRouter{
		EntryPoints: []string{"websecure"}, Rule: rule, Service: serviceName,
		TLS: &traefikTLS{CertificateResolver: "letsencrypt"},
	}
	return traefikDynamicConfiguration{HTTP: httpConfiguration}
}
