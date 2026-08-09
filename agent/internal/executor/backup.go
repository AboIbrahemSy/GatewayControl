package executor

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"gatewaycontrol/agent/internal/backuphelper"
	"gatewaycontrol/agent/internal/types"
)

const backupManifestVersion = 1

type stackBackupPayload struct {
	BackupID    string `json:"backupId"`
	StackID     string `json:"stackId"`
	ProjectName string `json:"projectName"`
	Revision    int64  `json:"revision"`
	Target      string `json:"target"`
	StackPath   string `json:"stackPath"`
	ComposePath string `json:"composePath"`
}

type stackRestorePayload struct {
	RestoreID   string `json:"restoreId"`
	BackupID    string `json:"backupId"`
	StackID     string `json:"stackId"`
	ProjectName string `json:"projectName"`
	Revision    int64  `json:"revision"`
	Target      string `json:"target"`
	StackPath   string `json:"stackPath"`
	ComposePath string `json:"composePath"`
}

type backupManifest struct {
	Version     int              `json:"version"`
	BackupID    string           `json:"backupId"`
	StackID     string           `json:"stackId"`
	ProjectName string           `json:"projectName"`
	Revision    int64            `json:"revision"`
	Target      string           `json:"target"`
	CreatedAt   time.Time        `json:"createdAt"`
	Volumes     []manifestVolume `json:"volumes"`
}

type manifestVolume struct {
	LogicalName string `json:"logicalName"`
	DockerName  string `json:"dockerName"`
	ArchiveName string `json:"archiveName"`
	SizeBytes   int64  `json:"sizeBytes"`
	SHA256      string `json:"sha256"`
}

type resolvedVolume struct {
	logical string
	docker  string
}

func (e *Executor) executeStackBackup(ctx context.Context, result types.CommandResult, raw json.RawMessage) types.CommandResult {
	payload, err := decodeStackBackupPayload(raw)
	if err != nil {
		return e.failure(result, err)
	}
	commandContext, cancel := context.WithTimeout(ctx, e.backupTimeout)
	defer cancel()
	composePath, base, err := e.prepareStack(commandContext, payload.StackID, payload.StackPath, payload.ComposePath, payload.ProjectName)
	_ = composePath
	if err != nil {
		return e.failure(result, err)
	}
	volumes, err := e.resolveOwnedVolumes(commandContext, base, payload.ProjectName)
	if err != nil {
		return e.failure(result, err)
	}
	backupRoot, hostBackupRoot, err := e.backupRoots(payload.Target)
	if err != nil {
		return e.failure(result, err)
	}
	destination, err := secureSubdirectory(backupRoot, strings.ToLower(payload.StackID), strings.ToLower(payload.BackupID))
	if err != nil {
		return e.failure(result, errors.New("prepare backup destination"))
	}
	hostDestination := filepath.Join(hostBackupRoot, strings.ToLower(payload.StackID), strings.ToLower(payload.BackupID))
	running, err := e.runningServices(commandContext, base)
	if err != nil {
		return e.failure(result, err)
	}
	if err := e.runCompose(commandContext, base, "stop"); err != nil {
		return e.failure(result, errors.New("stop stack for backup"))
	}
	defer e.restartServices(commandContext, base, running)

	manifest := backupManifest{Version: backupManifestVersion, BackupID: strings.ToLower(payload.BackupID), StackID: strings.ToLower(payload.StackID), ProjectName: payload.ProjectName, Revision: payload.Revision, Target: payload.Target, CreatedAt: time.Now().UTC(), Volumes: make([]manifestVolume, 0, len(volumes))}
	for _, volume := range volumes {
		archiveName := volume.logical + ".tar.gz"
		if err := e.runHelper(commandContext, "backup", volume.docker, hostDestination, archiveName); err != nil {
			return e.failure(result, errors.New("volume backup failed"))
		}
		size, checksum, err := checksumRegularFile(filepath.Join(destination, archiveName))
		if err != nil {
			return e.failure(result, errors.New("verify volume archive"))
		}
		manifest.Volumes = append(manifest.Volumes, manifestVolume{LogicalName: volume.logical, DockerName: volume.docker, ArchiveName: archiveName, SizeBytes: size, SHA256: checksum})
	}
	manifestBytes, err := json.Marshal(manifest)
	if err != nil {
		return e.failure(result, errors.New("encode backup manifest"))
	}
	if err := writeFileAtomically(filepath.Join(destination, "manifest.json"), manifestBytes, 0o600); err != nil {
		return e.failure(result, errors.New("publish backup manifest"))
	}
	return backupSuccess(result, payload.BackupID, "", payload.StackID, payload.Target, payload.Revision, manifest)
}

func (e *Executor) executeStackRestore(ctx context.Context, result types.CommandResult, raw json.RawMessage) types.CommandResult {
	payload, err := decodeStackRestorePayload(raw)
	if err != nil {
		return e.failure(result, err)
	}
	commandContext, cancel := context.WithTimeout(ctx, e.backupTimeout)
	defer cancel()
	_, base, err := e.prepareStack(commandContext, payload.StackID, payload.StackPath, payload.ComposePath, payload.ProjectName)
	if err != nil {
		return e.failure(result, err)
	}
	backupRoot, hostBackupRoot, err := e.backupRoots(payload.Target)
	if err != nil {
		return e.failure(result, err)
	}
	directory, err := secureSubdirectory(backupRoot, strings.ToLower(payload.StackID), strings.ToLower(payload.BackupID))
	if err != nil {
		return e.failure(result, errors.New("backup directory is unsafe"))
	}
	manifest, err := loadAndValidateManifest(directory, payload)
	if err != nil {
		return e.failure(result, err)
	}
	volumes, err := e.resolveOwnedVolumes(commandContext, base, payload.ProjectName)
	if err != nil {
		return e.failure(result, err)
	}
	resolved := make(map[string]string, len(volumes))
	for _, volume := range volumes {
		resolved[volume.logical] = volume.docker
	}
	for _, volume := range manifest.Volumes {
		if resolved[volume.LogicalName] == "" || resolved[volume.LogicalName] != volume.DockerName {
			return e.failure(result, errors.New("backup volume ownership no longer matches the stack"))
		}
	}
	if len(resolved) != len(manifest.Volumes) {
		return e.failure(result, errors.New("backup manifest does not contain every stack volume"))
	}
	running, err := e.runningServices(commandContext, base)
	if err != nil {
		return e.failure(result, err)
	}
	journalDirectory, err := secureSubdirectory(e.stateDir, "restore-journals")
	if err != nil {
		return e.failure(result, errors.New("prepare restore journal"))
	}
	journalPath := filepath.Join(journalDirectory, strings.ToLower(payload.StackID)+".json")
	if _, exists, readErr := readRegularFile(journalPath); readErr != nil || exists {
		return e.failure(result, errors.New("an unresolved restore journal blocks destructive work"))
	}
	journal, _ := json.Marshal(map[string]any{"restoreId": payload.RestoreID, "backupId": payload.BackupID, "stackId": payload.StackID, "phase": "prepared", "createdAt": time.Now().UTC()})
	if err := writeFileAtomically(journalPath, journal, 0o600); err != nil {
		return e.failure(result, errors.New("persist restore journal"))
	}
	if err := e.runCompose(commandContext, base, "stop"); err != nil {
		return e.failure(result, errors.New("stop stack for restore"))
	}
	defer e.restartServices(commandContext, base, running)
	hostDirectory := filepath.Join(hostBackupRoot, strings.ToLower(payload.StackID), strings.ToLower(payload.BackupID))
	for _, volume := range manifest.Volumes {
		if err := e.runHelper(commandContext, "restore", volume.DockerName, hostDirectory, volume.ArchiveName); err != nil {
			return e.failure(result, errors.New("volume restore failed; restore journal retained"))
		}
	}
	if err := os.Remove(journalPath); err != nil {
		return e.failure(result, errors.New("clear completed restore journal"))
	}
	return backupSuccess(result, payload.BackupID, payload.RestoreID, payload.StackID, payload.Target, payload.Revision, manifest)
}

func decodeStackBackupPayload(raw json.RawMessage) (stackBackupPayload, error) {
	var payload stackBackupPayload
	if err := strictDecode(raw, &payload); err != nil {
		return payload, fmt.Errorf("invalid backup payload: %w", err)
	}
	if err := validateOperationFields(payload.BackupID, payload.StackID, payload.ProjectName, payload.Revision, payload.Target, payload.StackPath, payload.ComposePath); err != nil {
		return payload, err
	}
	return payload, nil
}

func decodeStackRestorePayload(raw json.RawMessage) (stackRestorePayload, error) {
	var payload stackRestorePayload
	if err := strictDecode(raw, &payload); err != nil {
		return payload, fmt.Errorf("invalid restore payload: %w", err)
	}
	if !connectorUUIDPattern.MatchString(payload.RestoreID) {
		return payload, errors.New("restoreId must be a UUID")
	}
	if err := validateOperationFields(payload.BackupID, payload.StackID, payload.ProjectName, payload.Revision, payload.Target, payload.StackPath, payload.ComposePath); err != nil {
		return payload, err
	}
	return payload, nil
}

func validateOperationFields(backupID, stackID, projectName string, revision int64, target, stackPath, composePath string) error {
	if !connectorUUIDPattern.MatchString(backupID) || !connectorUUIDPattern.MatchString(stackID) || !projectPattern.MatchString(projectName) || revision < 1 {
		return errors.New("invalid backup or stack fields")
	}
	if target != "local" && target != "nas" {
		return errors.New("target must be local or nas")
	}
	if stackPath != stackID || composePath != stackID+"/compose.yaml" {
		return errors.New("stack paths do not match stackId")
	}
	return nil
}

func (e *Executor) prepareStack(ctx context.Context, stackID, stackPath, composePath, projectName string) (string, []string, error) {
	resolved, err := e.validatedStackComposePath(stackID, stackPath, composePath)
	if err != nil {
		return "", nil, err
	}
	hostDirectory, err := e.hostProjectDirectory(resolved)
	if err != nil {
		return "", nil, err
	}
	base := []string{"compose", "--project-name", projectName, "--project-directory", hostDirectory, "--file", resolved}
	if _, err := e.runner.Run(ctx, "docker", append(append([]string{}, base...), "config", "--quiet"), e.maxOutput); err != nil {
		return "", nil, errors.New("stack Compose configuration is invalid")
	}
	return resolved, base, nil
}

func (e *Executor) resolveOwnedVolumes(ctx context.Context, base []string, projectName string) ([]resolvedVolume, error) {
	output, err := e.runner.Run(ctx, "docker", append(append([]string{}, base...), "config", "--volumes"), e.maxOutput)
	if err != nil {
		return nil, errors.New("list stack volumes")
	}
	logicalNames := nonemptyUniqueLines(output.stdout)
	if len(logicalNames) > 1000 {
		return nil, errors.New("stack has too many volumes")
	}
	volumes := make([]resolvedVolume, 0, len(logicalNames))
	for _, logical := range logicalNames {
		if !composeServicePattern.MatchString(logical) {
			return nil, errors.New("Compose returned an invalid logical volume name")
		}
		listed, listErr := e.runner.Run(ctx, "docker", []string{"volume", "ls", "--quiet", "--filter", "label=com.docker.compose.project=" + projectName, "--filter", "label=com.docker.compose.volume=" + logical}, e.maxOutput)
		matches := nonemptyUniqueLines(listed.stdout)
		if listErr != nil || len(matches) != 1 || !dockerObjectNamePattern.MatchString(matches[0]) {
			return nil, errors.New("stack volume is missing, external, or ambiguously owned")
		}
		inspected, inspectErr := e.runner.Run(ctx, "docker", []string{"volume", "inspect", "--format", "{{json .Labels}}", matches[0]}, e.maxOutput)
		var labels map[string]string
		if inspectErr != nil || json.Unmarshal([]byte(strings.TrimSpace(inspected.stdout)), &labels) != nil || labels["com.docker.compose.project"] != projectName || labels["com.docker.compose.volume"] != logical {
			return nil, errors.New("stack volume ownership labels are invalid")
		}
		volumes = append(volumes, resolvedVolume{logical: logical, docker: matches[0]})
	}
	return volumes, nil
}

func (e *Executor) backupRoots(target string) (string, string, error) {
	if target == "local" {
		if _, err := secureSubdirectory(e.localBackupRoot); err != nil {
			return "", "", errors.New("local backup root is unavailable")
		}
		rootInfo, err := os.Lstat(e.localBackupRoot)
		if err != nil || !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
			return "", "", errors.New("local backup root is unsafe")
		}
		return e.localBackupRoot, e.hostLocalBackupRoot, nil
	}
	rootInfo, err := os.Lstat(e.nasBackupRoot)
	if err != nil || !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
		return "", "", errors.New("NAS backup root is unavailable")
	}
	markerInfo, err := os.Lstat(filepath.Join(e.nasBackupRoot, e.nasMarker))
	if err != nil || !markerInfo.Mode().IsRegular() || markerInfo.Mode()&os.ModeSymlink != 0 {
		return "", "", errors.New("NAS marker is missing or unsafe")
	}
	return e.nasBackupRoot, e.hostNASBackupRoot, nil
}

func (e *Executor) runningServices(ctx context.Context, base []string) ([]string, error) {
	output, err := e.runner.Run(ctx, "docker", append(append([]string{}, base...), "ps", "--services", "--filter", "status=running"), e.maxOutput)
	if err != nil {
		return nil, errors.New("inspect running stack services")
	}
	return nonemptyUniqueLines(output.stdout), nil
}

func (e *Executor) runCompose(ctx context.Context, base []string, action string) error {
	_, err := e.runner.Run(ctx, "docker", append(append([]string{}, base...), action), e.maxOutput)
	return err
}

func (e *Executor) restartServices(ctx context.Context, base, services []string) {
	if len(services) == 0 {
		return
	}
	if ctx.Err() != nil {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(context.Background(), e.timeout)
		defer cancel()
	}
	args := append(append([]string{}, base...), "up", "--detach", "--no-deps")
	args = append(args, services...)
	_, _ = e.runner.Run(ctx, "docker", args, e.maxOutput)
}

func (e *Executor) runHelper(ctx context.Context, mode, volume, hostDirectory, archive string) error {
	sourceMount := "type=volume,src=" + volume + ",dst=/source"
	if mode == "backup" {
		sourceMount += ",readonly"
	}
	args := []string{
		"run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
		"--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER", "--cap-add", "CHOWN",
		"--pids-limit", "64", "--user", "0:0", "--entrypoint", "/usr/local/bin/gateway-backup-helper",
		"--mount", sourceMount, "--mount", "type=bind,src=" + hostDirectory + ",dst=/backup", e.agentImage, mode, archive,
	}
	_, err := e.runner.Run(ctx, "docker", args, e.maxOutput)
	return err
}

func loadAndValidateManifest(directory string, payload stackRestorePayload) (backupManifest, error) {
	contents, exists, err := readRegularFile(filepath.Join(directory, "manifest.json"))
	if err != nil || !exists || len(contents) > 1<<20 {
		return backupManifest{}, errors.New("backup manifest is unavailable")
	}
	var manifest backupManifest
	if err := strictDecode(contents, &manifest); err != nil || manifest.Version != backupManifestVersion || !strings.EqualFold(manifest.BackupID, payload.BackupID) || !strings.EqualFold(manifest.StackID, payload.StackID) || manifest.ProjectName != payload.ProjectName || manifest.Revision != payload.Revision || manifest.Target != payload.Target || manifest.CreatedAt.IsZero() || manifest.CreatedAt.After(time.Now().UTC().Add(5*time.Minute)) || len(manifest.Volumes) > 1000 {
		return backupManifest{}, errors.New("backup manifest does not match restore request")
	}
	seen := make(map[string]struct{})
	for _, volume := range manifest.Volumes {
		if !composeServicePattern.MatchString(volume.LogicalName) || !dockerObjectNamePattern.MatchString(volume.DockerName) || volume.ArchiveName != volume.LogicalName+".tar.gz" || len(volume.SHA256) != 64 || volume.SizeBytes < 0 {
			return backupManifest{}, errors.New("backup manifest contains an invalid volume")
		}
		if _, exists := seen[volume.LogicalName]; exists {
			return backupManifest{}, errors.New("backup manifest contains duplicate volumes")
		}
		seen[volume.LogicalName] = struct{}{}
		size, checksum, checksumErr := checksumRegularFile(filepath.Join(directory, volume.ArchiveName))
		if checksumErr != nil || size != volume.SizeBytes || !strings.EqualFold(checksum, volume.SHA256) {
			return backupManifest{}, errors.New("backup archive checksum validation failed")
		}
		if err := backuphelper.ValidateArchive(filepath.Join(directory, volume.ArchiveName)); err != nil {
			return backupManifest{}, errors.New("backup archive safety validation failed")
		}
	}
	return manifest, nil
}

func checksumRegularFile(path string) (int64, string, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return 0, "", errors.New("archive must be a regular file")
	}
	file, err := os.Open(path)
	if err != nil {
		return 0, "", err
	}
	defer file.Close()
	hash := sha256.New()
	written, err := io.Copy(hash, file)
	if err != nil || written != info.Size() {
		return 0, "", errors.New("read archive")
	}
	return info.Size(), hex.EncodeToString(hash.Sum(nil)), nil
}

func nonemptyUniqueLines(value string) []string {
	seen := make(map[string]struct{})
	result := make([]string, 0)
	for _, line := range strings.Split(value, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if _, exists := seen[line]; !exists {
			seen[line] = struct{}{}
			result = append(result, line)
		}
	}
	sort.Strings(result)
	return result
}

func backupSuccess(result types.CommandResult, backupID, restoreID, stackID, target string, revision int64, manifest backupManifest) types.CommandResult {
	var size int64
	for _, volume := range manifest.Volumes {
		size += volume.SizeBytes
	}
	encoded, _ := json.Marshal(manifest)
	checksum := sha256.Sum256(encoded)
	result.Success, result.ExitCode, result.FinishedAt = true, 0, time.Now().UTC()
	result.BackupID, result.RestoreID, result.StackID, result.Target, result.Revision = backupID, restoreID, stackID, target, revision
	result.SizeBytes, result.FileCount, result.Checksum = size, len(manifest.Volumes), hex.EncodeToString(checksum[:])
	return result
}
