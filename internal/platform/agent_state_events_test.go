package platform

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	agent "github.com/alfredxw/denova/agent"
)

func TestAgentStateEventsContainObservableStatus(t *testing.T) {
	execution := &agentExecution{}
	for _, payload := range []agent.EventPayload{agent.RunStarted{}, agent.InteractionResolved{}} {
		execution.receipt.Result.Status = "waiting"
		execution.consume(agent.Event{Payload: payload})
		event := execution.events[len(execution.events)-1]
		data, err := json.Marshal(event.Data)
		if err != nil || event.Kind != "state" || string(data) != `{"status":"running"}` {
			t.Fatalf("SSE state cannot be observed by consumers: %#v %s %v", event, data, err)
		}
	}
}

func TestAgentEventsSnapshotReplaysPendingQuestions(t *testing.T) {
	for _, state := range []string{"pending", "resolved"} {
		t.Run(state, func(t *testing.T) {
			execution := &agentExecution{done: make(chan struct{}), generation: "test"}
			question := agent.InteractionRequest{ID: "question", Kind: agent.InteractionAsk, Questions: []agent.InteractionQuestion{{ID: "mood", Prompt: "Target mood", AllowFreeText: true}}}
			execution.consume(agent.Event{Payload: agent.InteractionRequested{Request: question}})
			if state == "resolved" {
				execution.consume(agent.Event{Payload: agent.InteractionResolved{ID: question.ID}})
			}
			ctx, cancel := context.WithCancel(t.Context())
			cancel()
			response := httptest.NewRecorder()
			serveAgentEvents(response, httptest.NewRequest("GET", "/events", nil).WithContext(ctx), execution, RunResult{})
			if body := response.Body.String(); !strings.Contains(body, "event: snapshot") || strings.Contains(body, "event: interaction") != (state == "pending") || strings.Contains(body, "Target mood") != (state == "pending") {
				t.Fatalf("late event attachment lost its pending question: %s", body)
			}
		})
	}
}
