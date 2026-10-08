package api

import (
	"context"
	"net/http"
	"testing"

	"denova/config"
	runtimeapp "denova/internal/app"
	"github.com/cloudwego/hertz/pkg/app"
	hertzserver "github.com/cloudwego/hertz/pkg/app/server"
	"github.com/cloudwego/hertz/pkg/common/ut"
)

func TestNewServerUsesLocalHostByDefault(t *testing.T) {
	application := newTestApplication(t)
	server := NewServer(application, "0")
	if server.host != config.LocalHTTPHost {
		t.Fatalf("server host = %q, want %q", server.host, config.LocalHTTPHost)
	}
}

func TestNewServerUsesLANHostWhenEnabled(t *testing.T) {
	root := t.TempDir()
	hash, err := config.HashRemoteAccessPassword("secret")
	if err != nil {
		t.Fatal(err)
	}
	application, err := runtimeapp.New(context.Background(), &config.Config{
		OpenAIModel:              "test-model",
		NovaDir:                  root,
		Workspace:                root,
		ResumeLastWorkspace:      false,
		AllowLANAccess:           true,
		RemoteAccessUsername:     "reader",
		RemoteAccessPasswordHash: hash,
	})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(application, "0")
	if server.host != config.LANHTTPHost {
		t.Fatalf("server host = %q, want %q", server.host, config.LANHTTPHost)
	}
}

func TestIsLocalClientIP(t *testing.T) {
	for _, value := range []string{"127.0.0.1", "::1"} {
		if !isLocalClientIP(value) {
			t.Fatalf("%s should be local", value)
		}
	}
	for _, value := range []string{"192.168.1.8", "10.0.0.2", ""} {
		if isLocalClientIP(value) {
			t.Fatalf("%s should be remote", value)
		}
	}
}

func TestForwardedClientIPUsesProxyAppendedAddress(t *testing.T) {
	// Earlier entries are supplied by the client and must never be trusted.
	if got := forwardedClientIP(" 127.0.0.1, 192.168.1.8"); got != "192.168.1.8" {
		t.Fatalf("forwardedClientIP = %q", got)
	}
	if got := forwardedClientIP("192.168.1.8,::ffff:127.0.0.1"); got != "::ffff:127.0.0.1" {
		t.Fatalf("forwardedClientIP = %q", got)
	}
	for _, header := range []string{"127.0.0.1, unknown", "127.0.0.1, ", ""} {
		if got := forwardedClientIP(header); got != "" {
			t.Fatalf("forwardedClientIP(%q) = %q, want no trusted address", header, got)
		}
	}
}

func TestLocalHostEffectMiddlewareRejectsForwardedRemoteClient(t *testing.T) {
	called := false
	server := hertzserver.Default()
	server.POST("/native", localHostEffectMiddleware, func(_ context.Context, c *app.RequestContext) {
		called = true
		c.Status(http.StatusNoContent)
	})
	response := ut.PerformRequest(
		server.Engine,
		http.MethodPost,
		"/native",
		nil,
		ut.Header{Key: "X-Forwarded-For", Value: "192.168.1.8"},
		ut.Header{Key: "X-Denova-Locale", Value: "en-US"},
	)
	if response.Code != http.StatusForbidden || called {
		t.Fatalf("remote host effect response = %d called=%v body=%s", response.Code, called, response.Body.String())
	}
}

func TestLocalHostEffectMiddlewareRejectsNonLoopbackHost(t *testing.T) {
	called := false
	server := hertzserver.Default()
	server.POST("/native", localHostEffectMiddleware, func(_ context.Context, c *app.RequestContext) {
		called = true
		c.Status(http.StatusNoContent)
	})
	response := ut.PerformRequest(server.Engine, http.MethodPost, "http://rebound.example:8080/native", nil)
	if response.Code != http.StatusForbidden || called {
		t.Fatalf("rebound host effect response = %d called=%v", response.Code, called)
	}
	response = ut.PerformRequest(server.Engine, http.MethodPost, "http://localhost:8080/native", nil)
	if response.Code != http.StatusNoContent || !called {
		t.Fatalf("local host effect response = %d called=%v", response.Code, called)
	}
}
