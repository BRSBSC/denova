package chat

import (
	"testing"

	agentconversation "denova/internal/agents/conversation"
	agentrun "denova/internal/agents/run"
	"denova/internal/agents/session"

	agentschema "github.com/alfredxw/denova/agent/schema"
)

func TestDisplayEventRecorderKeepsInterleavedSubAgentTextInStableSegments(t *testing.T) {
	store, err := session.NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	sess, err := store.GetOrCreate("interleaved-subagents")
	if err != nil {
		t.Fatal(err)
	}
	recorder := newDisplayEventRecorder(agentconversation.NewSessionConversation(sess), displayEventRecorderOptions{})
	eventData := func(sessionID, content string) map[string]any {
		return agentEventMetadata{
			RunID: "run-1", AgentKind: "ide", AgentName: "general-purpose", RootAgentName: "root",
			RunPath: []string{"root", "general-purpose"}, SubAgent: true, SubAgentSessionID: sessionID, SubAgentType: "task",
		}.appendTo(map[string]any{"content": content})
	}

	aThinking1 := eventData("child-a", "A thinks ")
	bThinking1 := eventData("child-b", "B thinks ")
	aThinking2 := eventData("child-a", "again")
	bThinking2 := eventData("child-b", "again")
	aThinking1["parent_call_id"] = "task-a"
	aThinking2["parent_call_id"] = "child-tool-a"
	for _, data := range []map[string]any{aThinking1, bThinking1, aThinking2, bThinking2} {
		recorder.Record(agentrun.Event{Type: "thinking", Data: data})
	}
	if eventDataString(aThinking1, displaySegmentIDEventKey) == "" || eventDataString(aThinking1, displaySegmentIDEventKey) != eventDataString(aThinking2, displaySegmentIDEventKey) {
		t.Fatalf("child A thinking segment IDs = %q, %q", eventDataString(aThinking1, displaySegmentIDEventKey), eventDataString(aThinking2, displaySegmentIDEventKey))
	}
	if eventDataString(bThinking1, displaySegmentIDEventKey) == "" || eventDataString(bThinking1, displaySegmentIDEventKey) != eventDataString(bThinking2, displaySegmentIDEventKey) {
		t.Fatalf("child B thinking segment IDs = %q, %q", eventDataString(bThinking1, displaySegmentIDEventKey), eventDataString(bThinking2, displaySegmentIDEventKey))
	}
	thinkingBySession := map[string]string{}
	for _, entry := range sess.History() {
		if entry.SubAgent && entry.Role == "thinking" {
			thinkingBySession[entry.SubAgentSessionID] = entry.Content
		}
	}
	if thinkingBySession["child-a"] != "A thinks again" || thinkingBySession["child-b"] != "B thinks again" {
		t.Fatalf("live subagent thinking was not durable before an assistant segment: %#v", thinkingBySession)
	}

	aAssistant1 := eventData("child-a", "A answer ")
	bAssistant1 := eventData("child-b", "B answer ")
	aAssistant2 := eventData("child-a", "done")
	bAssistant2 := eventData("child-b", "done")
	for _, data := range []map[string]any{aAssistant1, bAssistant1, aAssistant2, bAssistant2} {
		recorder.Record(agentrun.Event{Type: "chunk", Data: data})
	}
	if eventDataString(aAssistant1, displaySegmentIDEventKey) == "" || eventDataString(aAssistant1, displaySegmentIDEventKey) != eventDataString(aAssistant2, displaySegmentIDEventKey) {
		t.Fatalf("child A assistant segment IDs = %q, %q", eventDataString(aAssistant1, displaySegmentIDEventKey), eventDataString(aAssistant2, displaySegmentIDEventKey))
	}
	if eventDataString(bAssistant1, displaySegmentIDEventKey) == "" || eventDataString(bAssistant1, displaySegmentIDEventKey) != eventDataString(bAssistant2, displaySegmentIDEventKey) {
		t.Fatalf("child B assistant segment IDs = %q, %q", eventDataString(bAssistant1, displaySegmentIDEventKey), eventDataString(bAssistant2, displaySegmentIDEventKey))
	}

	for _, sessionID := range []string{"child-a", "child-b"} {
		data := eventData(sessionID, "")
		data["status"] = agentschema.ResultCompleted
		recorder.Record(agentrun.Event{Type: "subagent_settled", Data: data})
	}
	recorder.Record(agentrun.Event{Type: "done", Data: map[string]any{}})

	got := map[string]map[string]string{}
	for _, entry := range sess.History() {
		if !entry.SubAgent {
			continue
		}
		if got[entry.SubAgentSessionID] == nil {
			got[entry.SubAgentSessionID] = map[string]string{}
		}
		if previous := got[entry.SubAgentSessionID][entry.Role]; previous != "" {
			t.Fatalf("session %s has duplicate %s segments: %q and %q", entry.SubAgentSessionID, entry.Role, previous, entry.Content)
		}
		got[entry.SubAgentSessionID][entry.Role] = entry.Content
	}
	want := map[string]map[string]string{
		"child-a": {"thinking": "A thinks again", "assistant": "A answer done"},
		"child-b": {"thinking": "B thinks again", "assistant": "B answer done"},
	}
	if len(got) != len(want) {
		t.Fatalf("display sessions = %#v, want %#v", got, want)
	}
	for sessionID, roles := range want {
		for role, content := range roles {
			if got[sessionID][role] != content {
				t.Fatalf("session %s %s = %q, want %q", sessionID, role, got[sessionID][role], content)
			}
		}
	}
}

func TestDisplayEventRecorderStampsEachDeltaWithItsUTF16SegmentOffset(t *testing.T) {
	store, err := session.NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	sess, err := store.GetOrCreate("segment-offsets")
	if err != nil {
		t.Fatal(err)
	}
	recorder := newDisplayEventRecorder(agentconversation.NewSessionConversation(sess), displayEventRecorderOptions{})
	record := func(eventType, content string) any {
		data := agentEventMetadata{RunID: "run-1", AgentKind: "ide", AgentName: "root", RootAgentName: "root"}.appendTo(map[string]any{"content": content})
		recorder.Record(agentrun.Event{Type: eventType, Data: data})
		return data[agentrun.DisplaySegmentOffsetKey]
	}
	// The web client measures strings in UTF-16 code units: the emoji is two.
	for index, want := range []int{0, 2, 5} {
		if got := record("thinking", []string{"思考", "a😀", "b"}[index]); got != want {
			t.Fatalf("thinking delta %d offset = %v, want %d", index, got, want)
		}
	}
	// A new segment starts counting again.
	for index, want := range []int{0, 3} {
		if got := record("chunk", []string{"正文一", "二"}[index]); got != want {
			t.Fatalf("assistant delta %d offset = %v, want %d", index, got, want)
		}
	}
}
