package api

import (
	"sync"
	"time"
)

const (
	// loginFailureLimit is how many sign-ins a client may fail in a row before it has to wait.
	loginFailureLimit = 5
	// loginLockout is the wait after each failure at or beyond the limit.
	loginLockout = time.Minute
	// loginFailureMemory is how long a failure keeps counting.
	loginFailureMemory = 15 * time.Minute
	// loginThrottleClients bounds the addresses remembered at once.
	loginThrottleClients = 4096
)

// loginThrottle slows password guessing per client address. It is a delay, not
// an account lock: the right password works again after the wait, and other
// clients are never affected, so nobody can lock the owner out.
type loginThrottle struct {
	mu       sync.Mutex
	failures map[string]loginFailures
}

type loginFailures struct {
	count int
	last  time.Time
}

func newLoginThrottle() *loginThrottle {
	return &loginThrottle{failures: make(map[string]loginFailures)}
}

// retryAfter reports how long client must wait before its next sign-in is evaluated.
func (t *loginThrottle) retryAfter(client string, now time.Time) time.Duration {
	t.mu.Lock()
	defer t.mu.Unlock()
	entry, known := t.failures[client]
	if !known || entry.count < loginFailureLimit {
		return 0
	}
	return max(0, loginLockout-now.Sub(entry.last))
}

func (t *loginThrottle) failed(client string, now time.Time) {
	t.mu.Lock()
	defer t.mu.Unlock()
	entry, known := t.failures[client]
	if now.Sub(entry.last) > loginFailureMemory {
		entry.count = 0
	}
	entry.count++
	entry.last = now
	if !known && len(t.failures) >= loginThrottleClients {
		// ponytail: forgetting every client bounds memory. Whoever controls
		// thousands of addresses is not slowed by a per-address limit anyway;
		// add a shared limit if that becomes a real threat.
		clear(t.failures)
	}
	t.failures[client] = entry
}

func (t *loginThrottle) succeeded(client string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.failures, client)
}
