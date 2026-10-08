package protocols_test

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	agentmodel "github.com/alfredxw/denova/agent/model"
	"github.com/alfredxw/denova/agent/model/providers"
	"github.com/alfredxw/denova/agent/model/providers/protocols/anthropicmessages"
	"github.com/alfredxw/denova/agent/model/providers/protocols/openaichatcompletions"
	"github.com/alfredxw/denova/agent/model/providers/protocols/openairesponses"
	agentschema "github.com/alfredxw/denova/agent/schema"
)

func TestAdaptersMakeOneHTTPAttemptAndPreserveRetryHints(t *testing.T) {
	for _, adapter := range []providers.ProtocolAdapter{anthropicmessages.NewAdapter(), openaichatcompletions.NewAdapter(), openairesponses.NewAdapter()} {
		t.Run(string(adapter.ID()), func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Retry-After", "4")
				w.WriteHeader(http.StatusServiceUnavailable)
				_, _ = w.Write([]byte(`{"error":{"message":"temporarily overloaded","type":"overloaded_error","code":"server_error"}}`))
			}))
			defer server.Close()
			model, err := adapter.New(context.Background(), providers.ModelConfig{
				Provider: providers.ProviderOpenAICompatible, Protocol: adapter.ID(), APIKey: "test-key",
				Model: "test-model", BaseURL: server.URL, HTTPClient: server.Client(),
			})
			if err != nil {
				t.Fatal(err)
			}
			_, err = model.Generate(context.Background(), []*agentschema.Message{agentschema.UserMessage("go")})
			var failure *providers.APIError
			if !errors.As(err, &failure) || !failure.Retryable() || failure.RetryDelay() != 4*time.Second || calls.Load() != 1 {
				t.Fatalf("error=%#v calls=%d", err, calls.Load())
			}
			decision := agentmodel.TransientRetry(context.Background(), agentmodel.RetryContext{Attempt: 1, Err: err, OutputState: agentmodel.ModelOutputNone})
			if decision.Action != agentmodel.RetryAgain || decision.Delay < 4*time.Second {
				t.Fatalf("retry=%#v", decision)
			}
		})
	}
}

func TestStreamErrorEventsFollowTransientRetryPolicy(t *testing.T) {
	const interrupted = `data: {"error":{"message":"stream error: stream ID 47; INTERNAL_ERROR; received from peer","type":"upstream_stream_error"}}` + "\n\n"
	for _, test := range []struct {
		name    string
		adapter providers.ProtocolAdapter
		body    string
		want    agentmodel.RetryAction
	}{
		{"chat completions interrupted", openaichatcompletions.NewAdapter(), interrupted, agentmodel.RetryAgain},
		{"responses interrupted", openairesponses.NewAdapter(), interrupted, agentmodel.RetryAgain},
		{"responses server error event", openairesponses.NewAdapter(), `data: {"type":"error","code":"server_error","message":"boom","sequence_number":1}` + "\n\n", agentmodel.RetryAgain},
		{"anthropic api error", anthropicmessages.NewAdapter(), "event: error\n" + `data: {"type":"error","error":{"type":"api_error","message":"boom"}}` + "\n\n", agentmodel.RetryAgain},
		{"chat completions invalid request", openaichatcompletions.NewAdapter(), `data: {"error":{"message":"bad","type":"invalid_request_error"}}` + "\n\n", agentmodel.RetryStop},
		{"chat completions content filter", openaichatcompletions.NewAdapter(), `data: {"error":{"message":"filtered","code":"content_filter"}}` + "\n\n", agentmodel.RetryStop},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = io.WriteString(w, test.body)
			}))
			defer server.Close()
			model, err := test.adapter.New(context.Background(), providers.ModelConfig{
				Provider: providers.ProviderOpenAICompatible, Protocol: test.adapter.ID(), APIKey: "test-key",
				Model: "test-model", BaseURL: server.URL, HTTPClient: server.Client(),
			})
			if err != nil {
				t.Fatal(err)
			}
			stream, err := model.Stream(context.Background(), []*agentschema.Message{agentschema.UserMessage("go")})
			if err == nil {
				defer stream.Close()
				for err == nil {
					_, err = stream.Recv()
				}
			}
			var failure *providers.APIError
			if !errors.As(err, &failure) {
				t.Fatalf("error=%#v, want provider API error", err)
			}
			decision := agentmodel.TransientRetry(context.Background(), agentmodel.RetryContext{Attempt: 1, Err: err, OutputState: agentmodel.ModelOutputNone})
			if decision.Action != test.want {
				t.Fatalf("error=%v retry=%#v", err, decision)
			}
		})
	}
}

func TestPermanentProviderFailuresDoNotRetry(t *testing.T) {
	for _, failure := range []*providers.APIError{
		{StatusCode: 401}, {StatusCode: 403}, {StatusCode: 400},
		{StatusCode: 429, Code: "insufficient_quota"}, {StatusCode: 429, Kind: "billing_hard_limit_reached"},
	} {
		decision := agentmodel.TransientRetry(context.Background(), agentmodel.RetryContext{Attempt: 1, Err: failure})
		if decision.Action != agentmodel.RetryStop {
			t.Fatalf("failure=%#v decision=%#v", failure, decision)
		}
	}
}
