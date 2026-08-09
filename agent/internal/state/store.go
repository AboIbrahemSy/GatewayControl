package state

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"gatewaycontrol/agent/internal/types"
)

type Credentials struct {
	AgentID       string `json:"agent_id"`
	APICredential string `json:"api_credential"`
}

type CommandRecord struct {
	Status    string               `json:"status"`
	Result    *types.CommandResult `json:"result,omitempty"`
	Delivered bool                 `json:"delivered,omitempty"`
	UpdatedAt time.Time            `json:"updated_at"`
}

type data struct {
	Credentials *Credentials             `json:"credentials,omitempty"`
	Commands    map[string]CommandRecord `json:"commands"`
}

type Store struct {
	mu       sync.Mutex
	fileName string
	data     data
}

func Open(directory string) (*Store, error) {
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, fmt.Errorf("create state directory: %w", err)
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		return nil, fmt.Errorf("secure state directory: %w", err)
	}
	store := &Store{fileName: filepath.Join(directory, "state.json"), data: data{Commands: make(map[string]CommandRecord)}}
	contents, err := os.ReadFile(store.fileName)
	if errors.Is(err, os.ErrNotExist) {
		return store, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read state: %w", err)
	}
	if err := json.Unmarshal(contents, &store.data); err != nil {
		return nil, fmt.Errorf("decode state: %w", err)
	}
	if store.data.Commands == nil {
		store.data.Commands = make(map[string]CommandRecord)
	}
	if err := os.Chmod(store.fileName, 0o600); err != nil {
		return nil, fmt.Errorf("secure state file: %w", err)
	}
	return store, nil
}

func (s *Store) Credentials() (Credentials, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data.Credentials == nil {
		return Credentials{}, false
	}
	return *s.data.Credentials, true
}

func (s *Store) SaveCredentials(credentials Credentials) error {
	if credentials.AgentID == "" || credentials.APICredential == "" {
		return errors.New("agent ID and API credential are required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	copy := credentials
	s.data.Credentials = &copy
	return s.persistLocked()
}

func (s *Store) Command(id string) (CommandRecord, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	record, found := s.data.Commands[id]
	return record, found
}

func (s *Store) MarkRunning(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.data.Commands[id]; exists {
		return errors.New("command already recorded")
	}
	s.data.Commands[id] = CommandRecord{Status: "running", UpdatedAt: time.Now().UTC()}
	return s.persistLocked()
}

func (s *Store) SaveResult(result types.CommandResult) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	copy := result
	s.data.Commands[result.CommandID] = CommandRecord{Status: "completed", Result: &copy, UpdatedAt: time.Now().UTC()}
	return s.persistLocked()
}

func (s *Store) MarkDelivered(commandID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	record, found := s.data.Commands[commandID]
	if !found || record.Result == nil {
		return errors.New("command result is not recorded")
	}
	record.Delivered = true
	record.UpdatedAt = time.Now().UTC()
	// Keep the command tombstone indefinitely for at-most-once execution without retaining bulky output.
	record.Result.Stdout = ""
	record.Result.Stderr = ""
	record.Result.Logs = ""
	s.data.Commands[commandID] = record
	return s.persistLocked()
}

func (s *Store) PendingResults() []types.CommandResult {
	s.mu.Lock()
	defer s.mu.Unlock()
	results := make([]types.CommandResult, 0)
	for _, record := range s.data.Commands {
		if record.Result != nil && !record.Delivered {
			results = append(results, *record.Result)
		}
	}
	return results
}

func (s *Store) persistLocked() error {
	contents, err := json.MarshalIndent(s.data, "", "  ")
	if err != nil {
		return fmt.Errorf("encode state: %w", err)
	}
	temporary, err := os.CreateTemp(filepath.Dir(s.fileName), ".state-*")
	if err != nil {
		return fmt.Errorf("create temporary state: %w", err)
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return fmt.Errorf("secure temporary state: %w", err)
	}
	if _, err := temporary.Write(contents); err != nil {
		temporary.Close()
		return fmt.Errorf("write state: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return fmt.Errorf("sync state: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close state: %w", err)
	}
	if runtime.GOOS == "windows" {
		// The production target is Linux, where rename replaces atomically. Windows cannot replace an existing file with os.Rename.
		if err := os.Remove(s.fileName); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("remove previous state: %w", err)
		}
	}
	if err := os.Rename(temporaryName, s.fileName); err != nil {
		return fmt.Errorf("replace state: %w", err)
	}
	if err := os.Chmod(s.fileName, 0o600); err != nil {
		return err
	}
	if runtime.GOOS == "windows" {
		return nil
	}
	directory, err := os.Open(filepath.Dir(s.fileName))
	if err != nil {
		return fmt.Errorf("open state directory for sync: %w", err)
	}
	defer directory.Close()
	if err := directory.Sync(); err != nil {
		return fmt.Errorf("sync state directory: %w", err)
	}
	return nil
}
