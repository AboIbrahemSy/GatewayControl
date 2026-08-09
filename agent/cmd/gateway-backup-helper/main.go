package main

import (
	"fmt"
	"os"

	"gatewaycontrol/agent/internal/backuphelper"
)

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: gateway-backup-helper backup|restore ARCHIVE.tar.gz")
		os.Exit(2)
	}
	if err := backuphelper.Run(os.Args[1], "/source", "/backup", os.Args[2]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
