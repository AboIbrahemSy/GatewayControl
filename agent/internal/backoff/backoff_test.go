package backoff

import (
	"testing"
	"time"
)

func TestBackoffDoublesToMaximumAndResets(t *testing.T) {
	backoff := New(time.Second, 4*time.Second)
	for index, expected := range []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, 4 * time.Second} {
		if actual := backoff.Next(); actual != expected {
			t.Fatalf("Next() at %d = %s, want %s", index, actual, expected)
		}
	}
	backoff.Reset()
	if actual := backoff.Next(); actual != time.Second {
		t.Fatalf("Next() after reset = %s", actual)
	}
}
