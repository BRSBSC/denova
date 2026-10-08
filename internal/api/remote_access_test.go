package api

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"denova/config"
	"github.com/cloudwego/hertz/pkg/app"
	hertzserver "github.com/cloudwego/hertz/pkg/app/server"
	"github.com/cloudwego/hertz/pkg/common/ut"
)

func testRemoteAccess(t *testing.T) (*remoteAccessGate, *hertzserver.Hertz, *config.RemoteAccessConfig) {
	t.Helper()
	hash, err := config.HashRemoteAccessPassword("secret")
	if err != nil {
		t.Fatal(err)
	}
	access := &config.RemoteAccessConfig{DataDir: t.TempDir(), AllowLANAccess: true, Username: "reader", PasswordHash: hash}
	gate := newRemoteAccessGate(func() config.RemoteAccessConfig { return *access }, "8080")
	h := hertzserver.Default()
	h.Use(gate.middleware)
	gate.registerRoutes(h)
	for _, path := range []string{"/", "/assets/app.js", "/api/private", "/api/terminal/sessions/one/attach"} {
		h.GET(path, func(_ context.Context, c *app.RequestContext) { c.String(200, "loaded") })
	}
	h.POST("/api/private", func(_ context.Context, c *app.RequestContext) { c.Status(204) })
	return gate, h, access
}

func remoteRequest(h *hertzserver.Hertz, method, path, body, cookie string, headers ...ut.Header) *ut.ResponseRecorder {
	headers = append(headers, ut.Header{Key: "X-Forwarded-For", Value: "192.168.1.8"}, ut.Header{Key: "Content-Type", Value: "application/json"}, ut.Header{Key: "Cookie", Value: cookie})
	return ut.PerformRequest(h.Engine, method, path, &ut.Body{Body: strings.NewReader(body), Len: len(body)}, headers...)
}

func TestRemoteAccessBootstrapAndCookieLifecycle(t *testing.T) {
	gate, h, access := testRemoteAccess(t)
	for _, path := range []string{"/", "/assets/app.js", "/api/auth/status"} {
		if res := remoteRequest(h, "GET", path, "", ""); res.Code != 200 {
			t.Fatalf("public %s: %d", path, res.Code)
		}
	}
	for _, path := range []string{"/api/private", "/api/terminal/sessions/one/attach"} {
		res := remoteRequest(h, "GET", path, "", "")
		if res.Code != 401 || res.Header().Get("WWW-Authenticate") != "" {
			t.Fatalf("private %s: %d %v", path, res.Code, res.Header())
		}
	}
	bad := remoteRequest(h, "POST", "/api/auth/login", `{"username":"reader","password":"wrong"}`, "")
	if bad.Code != 401 {
		t.Fatalf("bad login: %d", bad.Code)
	}
	login := remoteRequest(h, "POST", "/api/auth/login", `{"username":"reader","password":"secret"}`, "")
	if login.Code != 200 {
		t.Fatalf("login: %d %s", login.Code, login.Body.String())
	}
	var status struct {
		Authenticated bool `json:"authenticated"`
	}
	if err := json.Unmarshal(login.Body.Bytes(), &status); err != nil || !status.Authenticated {
		t.Fatalf("login status: %s", login.Body.String())
	}
	cookies := (&http.Response{Header: http.Header{"Set-Cookie": []string{login.Header().Get("Set-Cookie")}}}).Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly || cookies[0].Secure || cookies[0].SameSite != http.SameSiteLaxMode || cookies[0].MaxAge != int(browserSessionLifetime.Seconds()) {
		t.Fatalf("HTTP cookie attributes: %v", login.Header())
	}
	cookie := cookies[0].Name + "=" + cookies[0].Value
	for _, path := range []string{"/", "/api/private", "/api/terminal/sessions/one/attach"} {
		if res := remoteRequest(h, "GET", path, "", cookie); res.Code != 200 {
			t.Fatalf("authenticated %s: %d", path, res.Code)
		}
	}
	restored := newBrowserSessions(access.DataDir)
	if !restored.authorized(cookies[0].Value, *access) {
		t.Fatal("login did not survive restart")
	}
	stored, err := os.ReadFile(filepath.Join(access.DataDir, "remote-access-sessions.json"))
	if err != nil || strings.Contains(string(stored), cookies[0].Value) || strings.Contains(string(stored), `"secret"`) {
		t.Fatal("raw credential persisted or store missing")
	}
	logout := remoteRequest(h, "POST", "/api/auth/logout", "", cookie)
	if logout.Code != 204 {
		t.Fatalf("logout: %d", logout.Code)
	}
	if gate.sessions.authorized(cookies[0].Value, *access) || newBrowserSessions(access.DataDir).authorized(cookies[0].Value, *access) {
		t.Fatal("revoked token remained valid")
	}
}

func TestRemoteAccessPairingAndCredentialChanges(t *testing.T) {
	gate, h, access := testRemoteAccess(t)
	if res := remoteRequest(h, "POST", "/api/auth/link", "", ""); res.Code != 401 {
		t.Fatalf("remote link request: %d", res.Code)
	}
	token, err := gate.sessions.issue(*access)
	if err != nil {
		t.Fatal(err)
	}
	if res := remoteRequest(h, "POST", "/api/auth/link", "", gate.cookieName+"="+token); res.Code != 403 {
		t.Fatalf("authenticated remote link request: %d", res.Code)
	}
	link := ut.PerformRequest(h.Engine, "POST", "http://localhost:8080/api/auth/link", nil)
	var result struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal(link.Body.Bytes(), &result); err != nil || !strings.Contains(result.URL, "/#pair=") {
		t.Fatalf("link: %d %s", link.Code, link.Body.String())
	}
	pairing := strings.Split(result.URL, "#pair=")[1]
	body := `{"token":"` + pairing + `"}`
	if res := remoteRequest(h, "POST", "/api/auth/pair", body, ""); res.Code != 200 {
		t.Fatalf("pair: %d %s", res.Code, res.Body.String())
	}
	if res := remoteRequest(h, "POST", "/api/auth/pair", body, ""); res.Code != 401 {
		t.Fatal("pairing link was reusable")
	}
	first, _ := gate.sessions.createPairing(*access)
	second, _ := gate.sessions.createPairing(*access)
	if _, err := gate.sessions.exchangePairing(first, *access); err == nil {
		t.Fatal("superseded link worked")
	}
	gate.sessions.pairing.ExpiresAt = time.Now().Add(-time.Second)
	if _, err := gate.sessions.exchangePairing(second, *access); err == nil {
		t.Fatal("expired link worked")
	}
	access.PasswordHash = "changed"
	if gate.sessions.authorized(token, *access) || newBrowserSessions(access.DataDir).authorized(token, *access) {
		t.Fatal("password change did not revoke old token")
	}
	access.AllowLANAccess = false
	if res := remoteRequest(h, "GET", "/", "", ""); res.Code != 403 {
		t.Fatal("disabled LAN gate allowed remote entry")
	}
}

func TestRemoteAccessOriginAndHTTPSCookie(t *testing.T) {
	_, h, _ := testRemoteAccess(t)
	for _, path := range []string{"/api/auth/login", "/api/auth/pair", "/api/auth/logout", "/api/private"} {
		res := remoteRequest(h, "POST", path, "{}", "", ut.Header{Key: "Origin", Value: "http://attacker.test"}, ut.Header{Key: "Host", Value: "192.168.1.9:8080"})
		if res.Code != 403 {
			t.Fatalf("cross-origin %s: %d", path, res.Code)
		}
	}
	res := remoteRequest(h, "GET", "/api/terminal/sessions/one/attach", "", "", ut.Header{Key: "Origin", Value: "http://attacker.test"}, ut.Header{Key: "Upgrade", Value: "websocket"})
	if res.Code != 403 {
		t.Fatalf("cross-origin socket: %d", res.Code)
	}
	login := remoteRequest(h, "POST", "/api/auth/login", `{"username":"reader","password":"secret"}`, "", ut.Header{Key: "Origin", Value: "https://denova.test"}, ut.Header{Key: "X-Forwarded-Host", Value: "denova.test"}, ut.Header{Key: "X-Forwarded-Proto", Value: "https"})
	if login.Code != 200 || !strings.Contains(strings.ToLower(login.Header().Get("Set-Cookie")), "secure") {
		t.Fatalf("HTTPS proxy login: %d %v", login.Code, login.Header())
	}
}

// Loopback peers skip the login, so every signal that the browser is somewhere
// else must win: a proxy-reported address, a forwarded host, or a Host header
// that only a tunnel or a rebound DNS name can produce.
func TestRemoteAccessLocalTrustRequiresLoopbackClientAndHost(t *testing.T) {
	_, h, _ := testRemoteAccess(t)
	local := "http://127.0.0.1:8080/api/private"
	for _, test := range []struct {
		name    string
		method  string
		url     string
		headers []ut.Header
		want    int
	}{
		{"direct local browser", "GET", "http://localhost:8080/api/private", nil, 200},
		{"direct IPv6 loopback", "GET", "http://[::1]:8080/api/private", nil, 200},
		{"local browser through the dev proxy", "GET", local, []ut.Header{{Key: "X-Forwarded-For", Value: "::ffff:127.0.0.1"}, {Key: "X-Forwarded-Host", Value: "localhost:5173"}}, 200},
		{"client-supplied loopback before the proxy address", "GET", local, []ut.Header{{Key: "X-Forwarded-For", Value: "127.0.0.1, 192.168.1.8"}}, 401},
		{"unparseable proxy address", "GET", local, []ut.Header{{Key: "X-Forwarded-For", Value: "127.0.0.1, unknown"}}, 401},
		{"proxy reporting only X-Real-IP", "GET", local, []ut.Header{{Key: "X-Real-IP", Value: "192.168.1.8"}}, 401},
		{"proxy forwarding a public host", "GET", local, []ut.Header{{Key: "X-Forwarded-Host", Value: "denova.example"}}, 401},
		{"tunnelled or rebound host", "GET", "http://rebound.example:8080/api/private", nil, 401},
		{"same-origin write from a rebound host", "POST", "http://rebound.example:8080/api/private", []ut.Header{{Key: "Origin", Value: "http://rebound.example:8080"}}, 401},
		{"request without a host", "GET", "/api/private", nil, 401},
	} {
		t.Run(test.name, func(t *testing.T) {
			if res := ut.PerformRequest(h.Engine, test.method, test.url, nil, test.headers...); res.Code != test.want {
				t.Fatalf("%s %s %v = %d, want %d", test.method, test.url, test.headers, res.Code, test.want)
			}
		})
	}
}

func TestRemoteAccessLoginSlowsRepeatedFailures(t *testing.T) {
	gate, h, _ := testRemoteAccess(t)
	// A wrong username fails before the password hash is computed, keeping the test fast.
	wrong, right := `{"username":"intruder","password":"guess"}`, `{"username":"reader","password":"secret"}`
	for attempt := 1; attempt <= loginFailureLimit; attempt++ {
		if res := remoteRequest(h, "POST", "/api/auth/login", wrong, ""); res.Code != 401 {
			t.Fatalf("failure %d: %d", attempt, res.Code)
		}
	}
	// The right password is not even evaluated while the client has to wait.
	locked := remoteRequest(h, "POST", "/api/auth/login", right, "", ut.Header{Key: "X-Denova-Locale", Value: "en-US"})
	if locked.Code != 429 || locked.Header().Get("Retry-After") == "" || !strings.Contains(locked.Body.String(), "Too many sign-in attempts") {
		t.Fatalf("locked out client: %d %v %s", locked.Code, locked.Header(), locked.Body.String())
	}
	other := ut.PerformRequest(h.Engine, "POST", "http://127.0.0.1:8080/api/auth/login", &ut.Body{Body: strings.NewReader(right), Len: len(right)},
		ut.Header{Key: "X-Forwarded-For", Value: "192.168.1.9"}, ut.Header{Key: "Content-Type", Value: "application/json"})
	if other.Code != 200 {
		t.Fatalf("another client was locked out too: %d %s", other.Code, other.Body.String())
	}
	// The wait is a delay, not an account lock: afterwards the right password works and clears the count.
	gate.logins.mu.Lock()
	waited := gate.logins.failures["192.168.1.8"]
	waited.last = time.Now().Add(-loginLockout)
	gate.logins.failures["192.168.1.8"] = waited
	gate.logins.mu.Unlock()
	if res := remoteRequest(h, "POST", "/api/auth/login", right, ""); res.Code != 200 {
		t.Fatalf("sign-in after the wait: %d %s", res.Code, res.Body.String())
	}
	if res := remoteRequest(h, "POST", "/api/auth/login", wrong, ""); res.Code != 401 {
		t.Fatalf("first failure after a successful sign-in: %d", res.Code)
	}
}

func TestRemoteAccessCorruptStoreFailsClosed(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "remote-access-sessions.json")
	if err := os.WriteFile(path, []byte("broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	store := newBrowserSessions(root)
	if _, err := store.issue(config.RemoteAccessConfig{}); err == nil {
		t.Fatal("corrupt store silently overwritten")
	}
	data, _ := os.ReadFile(path)
	if string(data) != "broken" {
		t.Fatal("corrupt store was overwritten")
	}
}
