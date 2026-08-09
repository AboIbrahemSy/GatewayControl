package executor

import (
	"context"
	"errors"
	"os/exec"
)

type runOutput struct {
	stdout    string
	stderr    string
	exitCode  int
	truncated bool
}

type commandRunner interface {
	Run(context.Context, string, []string, int64) (runOutput, error)
	LookPath(string) (string, error)
}

type osCommandRunner struct{}

func (osCommandRunner) Run(ctx context.Context, name string, args []string, maxOutput int64) (runOutput, error) {
	process := exec.CommandContext(ctx, name, args...)
	process.Env = subprocessEnvironment()
	stdout := newLimitedBuffer(maxOutput)
	stderr := newLimitedBuffer(maxOutput)
	process.Stdout = stdout
	process.Stderr = stderr
	err := process.Run()
	output := runOutput{
		stdout: stdout.String(), stderr: stderr.String(), exitCode: -1,
		truncated: stdout.truncated || stderr.truncated,
	}
	if err == nil {
		output.exitCode = 0
		return output, nil
	}
	var exitError *exec.ExitError
	if errors.As(err, &exitError) {
		output.exitCode = exitError.ExitCode()
	}
	return output, err
}

func (osCommandRunner) LookPath(name string) (string, error) {
	return exec.LookPath(name)
}
