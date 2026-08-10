package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var dockerNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)
var dockerVolumeNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{1,127}$`)
var pinnedImagePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._/-]*(?::[a-z0-9][a-z0-9._-]*)?(?:@sha256:[a-f0-9]{64})?$`)

type Config struct {
	ControlURL           *url.URL
	EnrollmentToken      string
	AgentName            string
	StateDir             string
	StateVolume          string
	StacksRoot           string
	HostStacksRoot       string
	HostProcRoot         string
	LocalBackupRoot      string
	HostLocalBackupRoot  string
	NASBackupRoot        string
	HostNASBackupRoot    string
	NASMarker            string
	AgentImage           string
	CloudflaredImage     string
	EdgeNetwork          string
	TraefikDynamicRoot   string
	TraefikDynamicVolume string
	AllowInsecureHTTP    bool
	HeartbeatInterval    time.Duration
	MetricsInterval      time.Duration
	BackupTimeout        time.Duration
	LongPollTimeout      time.Duration
	CommandTimeout       time.Duration
	DockerInfoTimeout    time.Duration
	MaxOutputBytes       int64
	ProtectedProjects    []string
}

func Load() (Config, error) {
	controlURLValue, err := requiredValue("GATEWAY_CONTROL_URL")
	if err != nil {
		return Config{}, err
	}
	agentName, err := valueOrDefault("GATEWAY_AGENT_NAME", "gateway-agent")
	if err != nil {
		return Config{}, err
	}
	stateDir, err := valueOrDefault("GATEWAY_STATE_DIR", "/var/lib/gateway-agent")
	if err != nil {
		return Config{}, err
	}
	stacksRoot, err := valueOrDefault("GATEWAY_STACKS_ROOT", "/srv/stacks")
	if err != nil {
		return Config{}, err
	}
	stateVolume, err := requiredValue("GATEWAY_STATE_VOLUME")
	if err != nil {
		return Config{}, err
	}
	hostStacksRoot, err := requiredValue("GATEWAY_HOST_STACKS_ROOT")
	if err != nil {
		return Config{}, err
	}
	hostProcRoot, err := valueOrDefault("GATEWAY_HOST_PROC_ROOT", "/host/proc")
	if err != nil {
		return Config{}, err
	}
	localBackupRoot, err := valueOrDefault("GATEWAY_LOCAL_BACKUP_ROOT", "/opt/gateway-control/backups/local")
	if err != nil {
		return Config{}, err
	}
	hostLocalBackupRoot, err := valueOrDefault("GATEWAY_HOST_LOCAL_BACKUP_ROOT", "/opt/gateway-control/backups/local")
	if err != nil {
		return Config{}, err
	}
	nasBackupRoot, err := valueOrDefault("GATEWAY_NAS_BACKUP_ROOT", "/mnt/gateway-control-backups")
	if err != nil {
		return Config{}, err
	}
	hostNASBackupRoot, err := valueOrDefault("GATEWAY_HOST_NAS_BACKUP_ROOT", "/mnt/gateway-control-backups")
	if err != nil {
		return Config{}, err
	}
	nasMarker, err := valueOrDefault("GATEWAY_NAS_MARKER", ".gateway-control-nas")
	if err != nil {
		return Config{}, err
	}
	agentImage, err := requiredValue("GATEWAY_AGENT_IMAGE")
	if err != nil {
		return Config{}, err
	}
	cloudflaredImage, err := valueOrDefault("GATEWAY_CLOUDFLARED_IMAGE", "cloudflare/cloudflared:2026.7.3")
	if err != nil {
		return Config{}, err
	}
	edgeNetwork, err := valueOrDefault("GATEWAY_EDGE_NETWORK", "gateway-control-edge")
	if err != nil {
		return Config{}, err
	}
	traefikDynamicRoot, err := valueOrDefault("GATEWAY_TRAEFIK_DYNAMIC_ROOT", "/srv/traefik-dynamic")
	if err != nil {
		return Config{}, err
	}
	traefikDynamicVolume, err := requiredValue("GATEWAY_TRAEFIK_DYNAMIC_VOLUME")
	if err != nil {
		return Config{}, err
	}

	allowHTTP, err := boolValue("GATEWAY_ALLOW_INSECURE_HTTP", false)
	if err != nil {
		return Config{}, err
	}
	controlURL, err := parseControlURL(controlURLValue, allowHTTP)
	if err != nil {
		return Config{}, err
	}
	if err := validateIdentifier(agentName); err != nil {
		return Config{}, fmt.Errorf("GATEWAY_AGENT_NAME: %w", err)
	}
	stateDir, err = filepath.Abs(stateDir)
	if err != nil {
		return Config{}, fmt.Errorf("resolve GATEWAY_STATE_DIR: %w", err)
	}
	stacksRoot, err = filepath.Abs(stacksRoot)
	if err != nil {
		return Config{}, fmt.Errorf("resolve GATEWAY_STACKS_ROOT: %w", err)
	}
	if !filepath.IsAbs(hostStacksRoot) {
		return Config{}, errors.New("GATEWAY_HOST_STACKS_ROOT must be an absolute host path")
	}
	for key, value := range map[string]string{
		"GATEWAY_HOST_PROC_ROOT":         hostProcRoot,
		"GATEWAY_LOCAL_BACKUP_ROOT":      localBackupRoot,
		"GATEWAY_HOST_LOCAL_BACKUP_ROOT": hostLocalBackupRoot,
		"GATEWAY_NAS_BACKUP_ROOT":        nasBackupRoot,
		"GATEWAY_HOST_NAS_BACKUP_ROOT":   hostNASBackupRoot,
	} {
		if !filepath.IsAbs(value) || filepath.Clean(value) != value {
			return Config{}, fmt.Errorf("%s must be an absolute, clean path", key)
		}
		if strings.ContainsAny(value, ",\r\n\x00") {
			return Config{}, fmt.Errorf("%s contains characters unsafe for a Docker mount", key)
		}
	}
	if filepath.Base(nasMarker) != nasMarker || nasMarker == "." || nasMarker == ".." {
		return Config{}, errors.New("GATEWAY_NAS_MARKER must be a file name")
	}
	if !pinnedImagePattern.MatchString(agentImage) || !hasPinnedImageReference(agentImage) || strings.HasSuffix(strings.ToLower(agentImage), ":latest") {
		return Config{}, errors.New("GATEWAY_AGENT_IMAGE must be an explicitly tagged or digest-pinned container image")
	}
	if pathsOverlap(localBackupRoot, nasBackupRoot) || pathsOverlap(hostLocalBackupRoot, hostNASBackupRoot) {
		return Config{}, errors.New("local and NAS backup roots must not overlap")
	}
	if pathsOverlap(localBackupRoot, stacksRoot) || pathsOverlap(nasBackupRoot, stacksRoot) || pathsOverlap(localBackupRoot, stateDir) || pathsOverlap(nasBackupRoot, stateDir) || pathsOverlap(hostLocalBackupRoot, hostStacksRoot) || pathsOverlap(hostNASBackupRoot, hostStacksRoot) {
		return Config{}, errors.New("backup roots must not overlap stack or state roots")
	}
	hostStacksRoot = filepath.Clean(hostStacksRoot)
	if !dockerVolumeNamePattern.MatchString(stateVolume) {
		return Config{}, errors.New("GATEWAY_STATE_VOLUME must be a valid Docker volume name")
	}
	if !dockerNamePattern.MatchString(edgeNetwork) {
		return Config{}, errors.New("GATEWAY_EDGE_NETWORK must be a valid Docker network name")
	}
	traefikDynamicRoot, err = filepath.Abs(traefikDynamicRoot)
	if err != nil {
		return Config{}, fmt.Errorf("resolve GATEWAY_TRAEFIK_DYNAMIC_ROOT: %w", err)
	}
	if !dockerVolumeNamePattern.MatchString(traefikDynamicVolume) {
		return Config{}, errors.New("GATEWAY_TRAEFIK_DYNAMIC_VOLUME must be a valid Docker volume name")
	}
	if !pinnedImagePattern.MatchString(cloudflaredImage) || !hasPinnedImageReference(cloudflaredImage) || strings.HasSuffix(strings.ToLower(cloudflaredImage), ":latest") {
		return Config{}, errors.New("GATEWAY_CLOUDFLARED_IMAGE must be an explicitly tagged or digest-pinned container image")
	}

	heartbeatInterval, err := durationValue("GATEWAY_HEARTBEAT_INTERVAL", 30*time.Second, time.Second)
	if err != nil {
		return Config{}, err
	}
	metricsInterval, err := durationValue("GATEWAY_METRICS_INTERVAL", 30*time.Second, 10*time.Second)
	if err != nil {
		return Config{}, err
	}
	backupTimeout, err := durationValue("GATEWAY_BACKUP_TIMEOUT", 60*time.Minute, time.Minute)
	if err != nil {
		return Config{}, err
	}
	longPollTimeout, err := durationValue("GATEWAY_LONG_POLL_TIMEOUT", 50*time.Second, 5*time.Second)
	if err != nil {
		return Config{}, err
	}
	commandTimeout, err := durationValue("GATEWAY_COMMAND_TIMEOUT", 5*time.Minute, time.Second)
	if err != nil {
		return Config{}, err
	}
	dockerInfoTimeout, err := durationValue("GATEWAY_DOCKER_INFO_TIMEOUT", 10*time.Second, time.Second)
	if err != nil {
		return Config{}, err
	}
	maxOutputBytes, err := int64Value("GATEWAY_MAX_OUTPUT_BYTES", 20_000, 1024, 20_000)
	if err != nil {
		return Config{}, err
	}
	protectedProjects := []string{"gateway-control"}
	protectedProjectSet := map[string]struct{}{"gateway-control": {}}
	protectedValue, err := optionalValue("GATEWAY_PROTECTED_PROJECTS")
	if err != nil {
		return Config{}, err
	}
	if protectedValue != "" {
		for _, project := range strings.Split(protectedValue, ",") {
			project = strings.TrimSpace(project)
			if !regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,62}$`).MatchString(project) {
				return Config{}, errors.New("GATEWAY_PROTECTED_PROJECTS must contain at most 20 valid comma-separated Compose project names")
			}
			if _, exists := protectedProjectSet[project]; exists {
				continue
			}
			if len(protectedProjects) >= 20 {
				return Config{}, errors.New("GATEWAY_PROTECTED_PROJECTS must contain at most 20 valid comma-separated Compose project names")
			}
			protectedProjects = append(protectedProjects, project)
			protectedProjectSet[project] = struct{}{}
		}
	}
	enrollmentToken, err := optionalValue("GATEWAY_ENROLLMENT_TOKEN")
	if err != nil {
		return Config{}, err
	}
	legacyEnrollmentToken, err := optionalValue("GATEWAY_CONTROL_ENROLLMENT_TOKEN")
	if err != nil {
		return Config{}, err
	}
	if enrollmentToken != "" && legacyEnrollmentToken != "" {
		return Config{}, errors.New("GATEWAY_ENROLLMENT_TOKEN and GATEWAY_CONTROL_ENROLLMENT_TOKEN are mutually exclusive")
	}
	if enrollmentToken == "" {
		enrollmentToken = legacyEnrollmentToken
	}

	return Config{
		ControlURL: controlURL, EnrollmentToken: enrollmentToken, AgentName: agentName,
		StateDir: stateDir, StateVolume: stateVolume, StacksRoot: stacksRoot, HostStacksRoot: hostStacksRoot,
		HostProcRoot: hostProcRoot, LocalBackupRoot: localBackupRoot, HostLocalBackupRoot: hostLocalBackupRoot,
		NASBackupRoot: nasBackupRoot, HostNASBackupRoot: hostNASBackupRoot, NASMarker: nasMarker, AgentImage: agentImage,
		CloudflaredImage: cloudflaredImage, EdgeNetwork: edgeNetwork, AllowInsecureHTTP: allowHTTP,
		TraefikDynamicRoot: traefikDynamicRoot, TraefikDynamicVolume: traefikDynamicVolume,
		HeartbeatInterval: heartbeatInterval, MetricsInterval: metricsInterval, BackupTimeout: backupTimeout, LongPollTimeout: longPollTimeout,
		CommandTimeout: commandTimeout, DockerInfoTimeout: dockerInfoTimeout,
		MaxOutputBytes: maxOutputBytes, ProtectedProjects: protectedProjects,
	}, nil
}

func pathsOverlap(first, second string) bool {
	contains := func(parent, child string) bool {
		relative, err := filepath.Rel(filepath.Clean(parent), filepath.Clean(child))
		return err == nil && (relative == "." || relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)))
	}
	return contains(first, second) || contains(second, first)
}

func hasPinnedImageReference(image string) bool {
	if strings.Contains(image, "@sha256:") {
		return true
	}
	lastSlash := strings.LastIndexByte(image, '/')
	return strings.Contains(image[lastSlash+1:], ":")
}

func parseControlURL(value string, allowHTTP bool) (*url.URL, error) {
	u, err := url.Parse(value)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("GATEWAY_CONTROL_URL must be an absolute URL without credentials, query, or fragment")
	}
	if u.Scheme != "https" && !(allowHTTP && u.Scheme == "http") {
		return nil, errors.New("GATEWAY_CONTROL_URL must use HTTPS (or explicitly enable GATEWAY_ALLOW_INSECURE_HTTP for development)")
	}
	u.Path = strings.TrimRight(u.Path, "/")
	return u, nil
}

func requiredValue(key string) (string, error) {
	value, err := optionalValue(key)
	if err != nil {
		return "", err
	}
	if value == "" {
		return "", fmt.Errorf("%s or %s_FILE is required", key, key)
	}
	return value, nil
}

func valueOrDefault(key, fallback string) (string, error) {
	value, err := optionalValue(key)
	if err != nil {
		return "", err
	}
	if value == "" {
		return fallback, nil
	}
	return value, nil
}

func optionalValue(key string) (string, error) {
	direct, directSet := os.LookupEnv(key)
	fileName, fileSet := os.LookupEnv(key + "_FILE")
	if directSet && fileSet {
		return "", fmt.Errorf("%s and %s_FILE are mutually exclusive", key, key)
	}
	if fileSet {
		data, err := os.ReadFile(fileName)
		if err != nil {
			return "", fmt.Errorf("read %s_FILE: %w", key, err)
		}
		return strings.TrimSpace(string(data)), nil
	}
	return strings.TrimSpace(direct), nil
}

func boolValue(key string, fallback bool) (bool, error) {
	value, err := optionalValue(key)
	if err != nil || value == "" {
		return fallback, err
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return false, fmt.Errorf("%s: %w", key, err)
	}
	return parsed, nil
}

func durationValue(key string, fallback, minimum time.Duration) (time.Duration, error) {
	value, err := optionalValue(key)
	if err != nil || value == "" {
		return fallback, err
	}
	parsed, err := time.ParseDuration(value)
	if err != nil || parsed < minimum {
		return 0, fmt.Errorf("%s must be a duration of at least %s", key, minimum)
	}
	return parsed, nil
}

func int64Value(key string, fallback, minimum, maximum int64) (int64, error) {
	value, err := optionalValue(key)
	if err != nil || value == "" {
		return fallback, err
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed < minimum || parsed > maximum {
		return 0, fmt.Errorf("%s must be between %d and %d", key, minimum, maximum)
	}
	return parsed, nil
}

func validateIdentifier(value string) error {
	if len(value) < 1 || len(value) > 128 {
		return errors.New("must contain 1 to 128 characters")
	}
	for _, character := range value {
		if (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') || character == '.' || character == '_' || character == '-' {
			continue
		}
		return errors.New("may contain only letters, numbers, dot, underscore, and hyphen")
	}
	return nil
}
