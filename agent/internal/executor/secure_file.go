package executor

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

func secureSubdirectory(root string, elements ...string) (string, error) {
	rootPath, err := filepath.Abs(root)
	if err != nil {
		return "", fmt.Errorf("resolve managed root: %w", err)
	}
	if err := os.MkdirAll(rootPath, 0o700); err != nil {
		return "", fmt.Errorf("create managed root: %w", err)
	}
	resolvedRoot, err := filepath.EvalSymlinks(rootPath)
	if err != nil {
		return "", fmt.Errorf("resolve managed root links: %w", err)
	}
	directory := resolvedRoot
	for _, element := range elements {
		if element == "" || filepath.Base(element) != element || element == "." || element == ".." {
			return "", errors.New("managed directory element is invalid")
		}
		directory = filepath.Join(directory, element)
		info, err := os.Lstat(directory)
		if errors.Is(err, os.ErrNotExist) {
			if err := os.Mkdir(directory, 0o700); err != nil {
				return "", fmt.Errorf("create managed directory: %w", err)
			}
		} else if err != nil {
			return "", fmt.Errorf("inspect managed directory: %w", err)
		} else if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return "", errors.New("managed directory must be a real directory")
		}
		if err := os.Chmod(directory, 0o700); err != nil {
			return "", fmt.Errorf("secure managed directory: %w", err)
		}
	}
	return directory, nil
}

func writeFileAtomically(path string, contents []byte, mode os.FileMode) error {
	directory := filepath.Dir(path)
	temporary, err := os.CreateTemp(directory, ".gateway-agent-*")
	if err != nil {
		return fmt.Errorf("create temporary managed file: %w", err)
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(mode); err != nil {
		temporary.Close()
		return fmt.Errorf("secure temporary managed file: %w", err)
	}
	if _, err := temporary.Write(contents); err != nil {
		temporary.Close()
		return fmt.Errorf("write managed file: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return fmt.Errorf("sync managed file: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close managed file: %w", err)
	}
	if runtime.GOOS == "windows" {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("remove previous managed file: %w", err)
		}
	}
	if err := os.Rename(temporaryName, path); err != nil {
		return fmt.Errorf("replace managed file: %w", err)
	}
	if err := os.Chmod(path, mode); err != nil {
		return fmt.Errorf("secure managed file: %w", err)
	}
	return syncDirectory(directory)
}

func readRegularFile(path string) ([]byte, bool, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("inspect managed file: %w", err)
	}
	if !info.Mode().IsRegular() {
		return nil, false, errors.New("managed file must be a regular file")
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		return nil, false, fmt.Errorf("read managed file: %w", err)
	}
	return contents, true, nil
}

func removeFileAndSync(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove managed file: %w", err)
	}
	return syncDirectory(filepath.Dir(path))
}

func restoreFile(path string, previous []byte, existed bool) error {
	if existed {
		return writeFileAtomically(path, previous, 0o600)
	}
	return removeFileAndSync(path)
}

func syncDirectory(directory string) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	handle, err := os.Open(directory)
	if err != nil {
		return fmt.Errorf("open managed directory for sync: %w", err)
	}
	defer handle.Close()
	if err := handle.Sync(); err != nil {
		return fmt.Errorf("sync managed directory: %w", err)
	}
	return nil
}
