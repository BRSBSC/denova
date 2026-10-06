package agent_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	agent "github.com/alfredxw/denova/agent"
	"github.com/alfredxw/denova/agent/providers"
	"github.com/alfredxw/denova/agent/providers/protocols/openaichatcompletions"
)

type strictCompactionContext struct{}

func (strictCompactionContext) Identity() agent.CapabilityIdentity {
	return agent.CapabilityIdentity{Kind: "test.strict-compaction-context", Version: 1}
}

func (strictCompactionContext) Materialize(context.Context, agent.ContextRequest) ([]agent.ContextFragment, error) {
	return []agent.ContextFragment{
		{Source: "project.creator", Purpose: "creative instructions", Resource: "CREATOR.md", Stability: agent.ContextStablePrefix, Placement: agent.ContextLeadingMessage, Role: agent.User, Content: "Preserve the stated budget.", HardLimit: 1024},
		{Source: "project.workspace", Purpose: "stable workspace sources", Resource: "sources", Stability: agent.ContextStablePrefix, Placement: agent.ContextLeadingMessage, Role: agent.User, Content: "Verify sources through the evidence tool.", HardLimit: 1024},
	}, nil
}

// Exercise the real adapter for both streaming turns and non-streaming summary
// forks. The endpoint enforces the single leading system rule of strict templates.
func newStrictCompactionChatModel(t *testing.T, engine *incrementalModel) agent.ToolCallingChatModel {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var input struct {
			Messages []*agent.Message `json:"messages"`
			Stream   bool             `json:"stream"`
		}
		if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
			t.Errorf("decode Chat Completions request: %v", err)
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		for index, message := range input.Messages {
			if message.Role == agent.System && index != 0 {
				writer.Header().Set("Content-Type", "application/json")
				writer.WriteHeader(http.StatusBadRequest)
				_, _ = fmt.Fprint(writer, `{"error":{"message":"System message must be at the beginning.","type":"invalid_request_error"}}`)
				return
			}
		}
		message, err := engine.Generate(request.Context(), input.Messages)
		if err != nil {
			writer.Header().Set("Content-Type", "application/json")
			writer.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(writer).Encode(map[string]any{"error": map[string]any{"message": err.Error(), "type": "invalid_request_error"}})
			return
		}
		if input.Stream {
			writer.Header().Set("Content-Type", "text/event-stream")
			chunk, err := json.Marshal(map[string]any{"id": "compaction", "choices": []any{map[string]any{"index": 0, "delta": message}}})
			if err != nil {
				t.Errorf("encode Chat Completions chunk: %v", err)
				return
			}
			_, _ = fmt.Fprintf(writer, "data: %s\n\ndata: [DONE]\n\n", chunk)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]any{"id": "compaction", "choices": []any{map[string]any{"index": 0, "message": message}}})
	}))
	t.Cleanup(server.Close)
	model, err := openaichatcompletions.NewAdapter().New(t.Context(), providers.ModelConfig{
		Provider: providers.ProviderOpenAICompatible, Protocol: providers.ProtocolOpenAIChatCompletions,
		BaseURL: server.URL + "/v1", Model: "strict-test-model", HTTPClient: server.Client(),
	})
	if err != nil {
		t.Fatal(err)
	}
	return model
}
