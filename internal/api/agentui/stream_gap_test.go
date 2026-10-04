package agentui

import (
	"bytes"
	"strings"
	"testing"

	agentrun "denova/internal/agents/run"
)

func TestStreamEncoderKeepsContentOpenAcrossObserverGaps(t *testing.T) {
	for _, test := range []struct {
		name      string
		eventType string
		chunkType string
		childID   string
	}{
		{name: "root text", eventType: "chunk", chunkType: "text"},
		{name: "root reasoning", eventType: "thinking", chunkType: "reasoning"},
		{name: "child text", eventType: "chunk", chunkType: "text", childID: "child"},
		{name: "child reasoning", eventType: "thinking", chunkType: "reasoning", childID: "child"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var out bytes.Buffer
			encoder := NewStreamEncoder(&out, "gap-test")
			write := func(eventType, segmentID, content string, cursor int) {
				t.Helper()
				data := map[string]any{"run_id": "run", "subagent_session_id": test.childID}
				if segmentID != "" {
					data["display_segment_id"] = segmentID
					data["content"] = content
				} else {
					data["dropped"] = 1
					data["resume_after"] = cursor
				}
				if err := encoder.WriteEvent(agentrun.Event{Type: eventType, Data: data}); err != nil {
					t.Fatal(err)
				}
			}
			write(test.eventType, "current", "Initial ", 0)
			const gaps = 1000
			for cursor := 1; cursor <= gaps; cursor++ {
				write("agent_event_stream_gap", "", "", cursor)
				write(test.eventType, "current", ".", cursor)
			}
			// A real segment change must still close the previous content.
			write(test.eventType, "next", "Next", 0)
			if err := encoder.Finish("stop"); err != nil {
				t.Fatal(err)
			}
			chunks, done := parseUIStreamChunks(t, out.String())
			if !done {
				t.Fatal("stream did not finish")
			}
			starts, ends, diagnostics := 0, 0, 0
			var current strings.Builder
			for _, chunk := range chunks {
				switch chunk["type"] {
				case test.chunkType + "-start":
					starts++
				case test.chunkType + "-end":
					ends++
				case test.chunkType + "-delta":
					if chunk["id"] == "current" {
						current.WriteString(chunk["delta"].(string))
					}
				case DataTypeActivity:
					data := chunk["data"].(map[string]any)
					if data["event"] != "agent_event_stream_gap" {
						t.Fatalf("unexpected activity: %#v", data)
					}
					diagnostics++
					if data["dropped"] != float64(1) || data["resume_after"] != float64(diagnostics) || data["subagent_session_id"] != test.childID {
						t.Fatalf("gap diagnostic lost its source or cursor: %#v", data)
					}
				}
			}
			if starts != 2 || ends != 2 || diagnostics != gaps {
				t.Fatalf("content boundaries starts=%d ends=%d diagnostics=%d, want 2/2/%d", starts, ends, diagnostics, gaps)
			}
			if want := "Initial " + strings.Repeat(".", gaps); current.String() != want {
				t.Fatalf("content changed across observer gaps: got %q, want %q", current.String(), want)
			}
		})
	}
}
