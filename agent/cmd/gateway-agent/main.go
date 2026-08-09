package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"gatewaycontrol/agent/internal/agent"
	"gatewaycontrol/agent/internal/config"
)

var version = "dev"

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "configuration error: %v\n", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	application, err := agent.New(cfg, version, logger)
	if err != nil {
		logger.Error("agent initialization failed", "error", err)
		os.Exit(1)
	}
	if err := application.Run(ctx); err != nil && ctx.Err() == nil {
		logger.Error("agent stopped", "error", err)
		os.Exit(1)
	}
	logger.Info("agent stopped gracefully")
}
