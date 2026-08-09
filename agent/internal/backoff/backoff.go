package backoff

import "time"

type Backoff struct {
	current time.Duration
	minimum time.Duration
	maximum time.Duration
}

func New(minimum, maximum time.Duration) *Backoff {
	return &Backoff{minimum: minimum, maximum: maximum}
}

func (b *Backoff) Next() time.Duration {
	if b.current == 0 {
		b.current = b.minimum
	} else {
		b.current = min(b.current*2, b.maximum)
	}
	return b.current
}

func (b *Backoff) Reset() { b.current = 0 }
