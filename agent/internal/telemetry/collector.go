package telemetry

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"gatewaycontrol/agent/internal/types"
)

const MaximumServices = 250

var dockerServiceFormat = `{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}\t{{.State}}\t{{.Status}}`

type Runner interface {
	Run(context.Context, string, ...string) ([]byte, error)
}

type Collector struct {
	procRoot string
	runner   Runner
	previousCPUTotal uint64
	previousCPUIdle  uint64
}

func New(procRoot string) *Collector {
	return &Collector{procRoot: procRoot, runner: OSRunner{}}
}

func (c *Collector) Collect(ctx context.Context) (types.Telemetry, error) {
	node, err := c.collectNode()
	if err != nil {
		return types.Telemetry{}, err
	}
	services, err := c.collectServices(ctx)
	if err != nil {
		return types.Telemetry{}, err
	}
	return types.Telemetry{ObservedAt: time.Now().UTC(), Node: node, Services: services}, nil
}

func (c *Collector) collectNode() (types.TelemetryNode, error) {
	uptime, err := readFields(filepath.Join(c.procRoot, "uptime"))
	if err != nil || len(uptime) < 1 {
		return types.TelemetryNode{}, errors.New("read host uptime")
	}
	loads, err := readFields(filepath.Join(c.procRoot, "loadavg"))
	if err != nil || len(loads) < 3 {
		return types.TelemetryNode{}, errors.New("read host load average")
	}
	numbers := make([]float64, 4)
	for index, value := range append(uptime[:1], loads[:3]...) {
		numbers[index], err = strconv.ParseFloat(value, 64)
		if err != nil || numbers[index] < 0 {
			return types.TelemetryNode{}, errors.New("parse host metrics")
		}
	}
	memory, err := os.Open(filepath.Join(c.procRoot, "meminfo"))
	if err != nil {
		return types.TelemetryNode{}, errors.New("read host memory")
	}
	defer memory.Close()
	var total, available uint64
	scanner := bufio.NewScanner(memory)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 2 {
			continue
		}
		value, parseErr := strconv.ParseUint(fields[1], 10, 64)
		if parseErr != nil || value > ^uint64(0)/1024 {
			return types.TelemetryNode{}, errors.New("parse host memory")
		}
		switch fields[0] {
		case "MemTotal:":
			total = value * 1024
		case "MemAvailable:":
			available = value * 1024
		}
	}
	if scanner.Err() != nil || total == 0 || available > total {
		return types.TelemetryNode{}, errors.New("parse host memory")
	}
	cpuPercent := c.collectCPUPercent()
	return types.TelemetryNode{UptimeSeconds: numbers[0], Load1: numbers[1], Load5: numbers[2], Load15: numbers[3], MemoryTotalBytes: total, MemoryAvailableBytes: available, CPUPercent: cpuPercent}, nil
}

func (c *Collector) collectCPUPercent() float64 {
	fields, err := readFields(filepath.Join(c.procRoot, "stat"))
	if err != nil || len(fields) < 6 || fields[0] != "cpu" {
		return 0
	}
	var total uint64
	values := make([]uint64, 0, len(fields)-1)
	for _, field := range fields[1:] {
		value, parseErr := strconv.ParseUint(field, 10, 64)
		if parseErr != nil {
			return 0
		}
		values = append(values, value)
		total += value
	}
	idle := values[3]
	if len(values) > 4 {
		idle += values[4]
	}
	previousTotal, previousIdle := c.previousCPUTotal, c.previousCPUIdle
	c.previousCPUTotal, c.previousCPUIdle = total, idle
	if previousTotal == 0 || total <= previousTotal || idle < previousIdle {
		return 0
	}
	totalDelta, idleDelta := total-previousTotal, idle-previousIdle
	if idleDelta >= totalDelta {
		return 0
	}
	return float64(totalDelta-idleDelta) * 100 / float64(totalDelta)
}

func (c *Collector) collectServices(ctx context.Context) ([]types.TelemetryService, error) {
	output, err := c.runner.Run(ctx, "docker", "ps", "--all", "--format", dockerServiceFormat)
	if err != nil {
		return nil, errors.New("collect Docker service state")
	}
	services := make([]types.TelemetryService, 0)
	indexes := make(map[string]int)
	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		if line == "" {
			continue
		}
		fields := strings.Split(line, "\t")
		if len(fields) != 4 || !validComposeProjectName(fields[0]) || !validComposeServiceName(fields[1]) {
			continue
		}
		key := fields[0] + "\x00" + fields[1]
		index, exists := indexes[key]
		if !exists {
			index = len(services)
			indexes[key] = index
			services = append(services, types.TelemetryService{Name: fields[0] + "/" + fields[1], ProjectName: fields[0], ServiceName: fields[1]})
		}
		service := &services[index]
		status := normalizeStatus(fields[2], fields[3])
		service.Total++
		switch status {
		case "healthy": service.Running++; service.Healthy++
		case "unhealthy": service.Running++; service.Unhealthy++
		case "starting": service.Running++; service.Starting++
		case "completed": service.Completed++
		case "stopped": service.Stopped++
		default: service.Running++
		}
		service.Status = aggregateStatus(*service)
		if len(services) == MaximumServices {
			if !exists { break }
		}
	}
	return services, nil
}

func aggregateStatus(service types.TelemetryService) string {
	if service.Unhealthy > 0 { return "unhealthy" }
	if service.Starting > 0 { return "starting" }
	if service.Completed == service.Total { return "completed" }
	if service.Stopped > 0 { return "stopped" }
	if service.Healthy == service.Total { return "healthy" }
	return "unknown"
}

func normalizeStatus(state, detail string) string {
	detail = strings.ToLower(detail)
	if state == "exited" && strings.Contains(detail, "exited (0)") {
		return "completed"
	}
	if state != "running" {
		return "stopped"
	}
	switch {
	case strings.Contains(detail, "(healthy)"):
		return "healthy"
	case strings.Contains(detail, "(unhealthy)"):
		return "unhealthy"
	case strings.Contains(detail, "health: starting") || strings.Contains(detail, "(starting)"):
		return "starting"
	default:
		return "unknown"
	}
}

func validComposeProjectName(value string) bool {
	if len(value) < 1 || len(value) > 63 {
		return false
	}
	for index, character := range value {
		if character >= 'a' && character <= 'z' || character >= '0' && character <= '9' || index > 0 && (character == '_' || character == '-') {
			continue
		}
		return false
	}
	return true
}

func validComposeServiceName(value string) bool {
	if len(value) < 1 || len(value) > 128 {
		return false
	}
	for index, character := range value {
		if character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' || character >= '0' && character <= '9' || index > 0 && (character == '_' || character == '-' || character == '.') {
			continue
		}
		return false
	}
	return true
}

func readFields(path string) ([]string, error) {
	contents, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return strings.Fields(string(contents)), nil
}

type OSRunner struct{}

func (OSRunner) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	command := exec.CommandContext(ctx, name, args...)
	var output bytes.Buffer
	command.Stdout = &output
	command.Stderr = &bytes.Buffer{}
	if err := command.Run(); err != nil {
		return nil, fmt.Errorf("run telemetry command: %w", err)
	}
	return output.Bytes(), nil
}
