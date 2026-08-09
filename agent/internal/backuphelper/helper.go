package backuphelper

import (
	"archive/tar"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

const MaximumFiles = 1_000_000
const MaximumExpandedBytes int64 = 100 << 30
const MaximumPathBytes = 4096

var archiveNamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,199}\.tar\.gz$`)

func Run(mode, sourceRoot, backupRoot, archiveName string) error {
	if !archiveNamePattern.MatchString(archiveName) {
		return errors.New("invalid archive name")
	}
	source, err := requireDirectory(sourceRoot)
	if err != nil {
		return err
	}
	backup, err := requireDirectory(backupRoot)
	if err != nil {
		return err
	}
	archive := filepath.Join(backup, archiveName)
	switch mode {
	case "backup":
		return createArchive(source, archive)
	case "restore":
		if err := ValidateArchive(archive); err != nil {
			return err
		}
		if err := clearDirectory(source); err != nil {
			return err
		}
		return extractArchive(archive, source)
	default:
		return errors.New("mode must be backup or restore")
	}
}

func ValidateArchive(archive string) error {
	archiveInfo, err := os.Lstat(archive)
	if err != nil || !archiveInfo.Mode().IsRegular() || archiveInfo.Mode()&os.ModeSymlink != 0 {
		return errors.New("archive must be a regular file")
	}
	return validateArchive(archive)
}

func createArchive(source, archive string) (returnErr error) {
	temporary, err := os.CreateTemp(filepath.Dir(archive), ".gateway-backup-*")
	if err != nil {
		return fmt.Errorf("create temporary archive: %w", err)
	}
	temporaryName := temporary.Name()
	defer func() {
		_ = temporary.Close()
		if returnErr != nil {
			_ = os.Remove(temporaryName)
		}
	}()
	gzipWriter := gzip.NewWriter(temporary)
	tarWriter := tar.NewWriter(gzipWriter)
	count := 0
	var total int64
	err = filepath.WalkDir(source, func(fileName string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if fileName == source {
			return nil
		}
		count++
		if count > MaximumFiles {
			return errors.New("archive file count limit exceeded")
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.IsDir() && !info.Mode().IsRegular() {
			return fmt.Errorf("unsupported source file type: %s", entry.Name())
		}
		relative, err := filepath.Rel(source, fileName)
		if err != nil {
			return err
		}
		archivePath := filepath.ToSlash(relative)
		if !safeArchivePath(archivePath) {
			return errors.New("unsafe source path")
		}
		if info.Mode().IsRegular() {
			if info.Size() < 0 || info.Size() > MaximumExpandedBytes-total {
				return errors.New("archive expanded size limit exceeded")
			}
			total += info.Size()
		}
		header, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return err
		}
		header.Name = archivePath
		header.Uname, header.Gname = "", ""
		if err := tarWriter.WriteHeader(header); err != nil {
			return err
		}
		if info.Mode().IsRegular() {
			file, err := os.Open(fileName)
			if err != nil {
				return err
			}
			_, copyErr := io.Copy(tarWriter, file)
			closeErr := file.Close()
			if copyErr != nil {
				return copyErr
			}
			return closeErr
		}
		return nil
	})
	if err == nil {
		err = tarWriter.Close()
	}
	if err == nil {
		err = gzipWriter.Close()
	}
	if err == nil {
		err = temporary.Sync()
	}
	if err == nil {
		err = temporary.Chmod(0o644)
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return fmt.Errorf("create archive: %w", err)
	}
	if err := os.Rename(temporaryName, archive); err != nil {
		return fmt.Errorf("publish archive: %w", err)
	}
	return nil
}

func validateArchive(archive string) error {
	return walkArchive(archive, func(*tar.Header, io.Reader) error { return nil })
}

func extractArchive(archive, source string) error {
	directories := make([]tar.Header, 0)
	err := walkArchive(archive, func(header *tar.Header, reader io.Reader) error {
		destination := filepath.Join(source, filepath.FromSlash(header.Name))
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(destination, fs.FileMode(header.Mode)&0o777); err != nil {
				return err
			}
			directories = append(directories, *header)
			return nil
		case tar.TypeReg, tar.TypeRegA:
			if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
				return err
			}
			file, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, fs.FileMode(header.Mode)&0o666)
			if err != nil {
				return err
			}
			_, copyErr := io.CopyN(file, reader, header.Size)
			closeErr := file.Close()
			if copyErr != nil {
				return copyErr
			}
			if closeErr != nil {
				return closeErr
			}
			if err := restoreOwnership(destination, header); err != nil {
				return err
			}
			return os.Chtimes(destination, header.ModTime, header.ModTime)
		default:
			return errors.New("unsafe archive entry type")
		}
	})
	if err != nil {
		return err
	}
	for index := len(directories) - 1; index >= 0; index-- {
		header := &directories[index]
		destination := filepath.Join(source, filepath.FromSlash(header.Name))
		if err := os.Chmod(destination, fs.FileMode(header.Mode)&0o777); err != nil {
			return err
		}
		if err := restoreOwnership(destination, header); err != nil {
			return err
		}
		if err := os.Chtimes(destination, header.ModTime, header.ModTime); err != nil {
			return err
		}
	}
	return nil
}

func walkArchive(archive string, visit func(*tar.Header, io.Reader) error) error {
	file, err := os.Open(archive)
	if err != nil {
		return fmt.Errorf("open archive: %w", err)
	}
	defer file.Close()
	gzipReader, err := gzip.NewReader(file)
	if err != nil {
		return errors.New("invalid gzip archive")
	}
	defer gzipReader.Close()
	reader := tar.NewReader(gzipReader)
	seen := make(map[string]struct{})
	count := 0
	var total int64
	for {
		header, err := reader.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return errors.New("invalid tar archive")
		}
		count++
		if count > MaximumFiles || !safeArchivePath(header.Name) || header.Size < 0 || header.Uid < 0 || header.Gid < 0 {
			return errors.New("archive safety limit exceeded")
		}
		if header.Typeflag != tar.TypeDir && header.Typeflag != tar.TypeReg && header.Typeflag != tar.TypeRegA {
			return errors.New("unsafe archive entry type")
		}
		clean := path.Clean(header.Name)
		if _, exists := seen[clean]; exists {
			return errors.New("duplicate archive entry")
		}
		seen[clean] = struct{}{}
		if header.Typeflag == tar.TypeReg || header.Typeflag == tar.TypeRegA {
			if header.Size > MaximumExpandedBytes-total {
				return errors.New("archive expanded size limit exceeded")
			}
			total += header.Size
		}
		if err := visit(header, reader); err != nil {
			return err
		}
	}
}

func restoreOwnership(path string, header *tar.Header) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	return os.Chown(path, header.Uid, header.Gid)
}

func safeArchivePath(name string) bool {
	return len(name) > 0 && len(name) <= MaximumPathBytes && !strings.ContainsAny(name, "\\\x00") && !path.IsAbs(name) && path.Clean(name) == name && name != ".." && !strings.HasPrefix(name, "../")
}

func clearDirectory(root string) error {
	entries, err := os.ReadDir(root)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if err := os.RemoveAll(filepath.Join(root, entry.Name())); err != nil {
			return err
		}
	}
	return nil
}

func requireDirectory(value string) (string, error) {
	if !filepath.IsAbs(value) || filepath.Clean(value) != value {
		return "", errors.New("root must be an absolute, clean path")
	}
	info, err := os.Lstat(value)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("root must be a real directory")
	}
	return value, nil
}
