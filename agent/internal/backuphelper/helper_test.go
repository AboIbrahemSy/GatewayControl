package backuphelper

import (
	"archive/tar"
	"compress/gzip"
	"os"
	"path/filepath"
	"testing"
)

func TestArchiveRoundTrip(t *testing.T) {
	source, backup := t.TempDir(), t.TempDir()
	if err := os.Mkdir(filepath.Join(source, "nested"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "nested", "data.txt"), []byte("original"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := Run("backup", source, backup, "volume.tar.gz"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "stale.txt"), []byte("stale"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Run("restore", source, backup, "volume.tar.gz"); err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(filepath.Join(source, "nested", "data.txt"))
	if err != nil || string(contents) != "original" {
		t.Fatalf("contents = %q, error = %v", contents, err)
	}
	if _, err := os.Stat(filepath.Join(source, "stale.txt")); !os.IsNotExist(err) {
		t.Fatal("restore did not clear stale data")
	}
}

func TestRestoreRejectsTraversalBeforeClearingSource(t *testing.T) {
	source, backup := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(source, "keep.txt"), []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	file, err := os.Create(filepath.Join(backup, "bad.tar.gz"))
	if err != nil {
		t.Fatal(err)
	}
	gzipWriter := gzip.NewWriter(file)
	tarWriter := tar.NewWriter(gzipWriter)
	_ = tarWriter.WriteHeader(&tar.Header{Name: "../escape", Mode: 0o600, Size: 1, Typeflag: tar.TypeReg})
	_, _ = tarWriter.Write([]byte("x"))
	_ = tarWriter.Close()
	_ = gzipWriter.Close()
	_ = file.Close()
	if err := Run("restore", source, backup, "bad.tar.gz"); err == nil {
		t.Fatal("expected traversal archive to be rejected")
	}
	if _, err := os.Stat(filepath.Join(source, "keep.txt")); err != nil {
		t.Fatal("source was cleared before archive validation")
	}
}
