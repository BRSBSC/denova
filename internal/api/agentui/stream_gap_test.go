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

func TestStreamEncoderMarksAResumedSegmentWithItsStartOffset(t *testing.T) {
	var out bytes.Buffer
	encoder := NewStreamEncoder(&out, "offset-test")
	write := func(segmentID, content string, offset int) {
		t.Helper()
		if err := encoder.WriteEvent(agentrun.Event{Type: "thinking", Data: map[string]any{
			"run_id": "run", "display_segment_id": segmentID, "content": content, agentrun.DisplaySegmentOffsetKey: offset,
		}}); err != nil {
			t.Fatal(err)
		}
	}
	// This connection joins "resumed" 40 units in; "fresh" starts on it.
	write("resumed", "ab", 40)
	write("resumed", "cd", 42)
	write("fresh", "ef", 0)
	write("fresh", "gh", 2)
	chunks, _ := parseUIStreamChunks(t, out.String())
	seen := 0
	for _, chunk := range chunks {
		if chunk["type"] != "reasoning-start" && chunk["type"] != "reasoning-delta" {
			continue
		}
		seen++
		agent, _ := chunk["providerMetadata"].(map[string]any)["agent"].(map[string]any)
		offset, stamped := agent[agentrun.DisplaySegmentOffsetKey]
		// Every chunk of a part repeats where the part starts, never where the
		// individual delta starts: the client keeps the latest part metadata.
		if chunk["id"] == "resumed" && offset != float64(40) {
			t.Fatalf("resumed chunk offset = %#v in %#v, want 40", offset, chunk)
		}
		if chunk["id"] == "fresh" && stamped {
			t.Fatalf("a part that holds its whole segment must not carry an offset: %#v", chunk)
		}
	}
	if seen != 6 {
		t.Fatalf("reasoning chunks = %d, want two starts and four deltas", seen)
	}
}

func TestStreamEncoderIsAnchorableUnlessAToolOrUnstampedSegmentIsOpen(t *testing.T) {
	var out bytes.Buffer
	encoder := NewStreamEncoder(&out, "anchor-test")
	step := func(want bool, eventType string, data map[string]any) {
		t.Helper()
		if err := encoder.WriteEvent(agentrun.Event{Type: eventType, Data: data}); err != nil {
			t.Fatal(err)
		}
		if got := encoder.Anchorable(); got != want {
			t.Fatalf("Anchorable() after %s %v = %t, want %t", eventType, data, got, want)
		}
	}
	// An open segment is fine when history can supply everything before it.
	step(true, "thinking", map[string]any{"run_id": "run", "display_segment_id": "s1", "content": "plan", agentrun.DisplaySegmentOffsetKey: 0})
	step(false, "tool_call", map[string]any{"run_id": "run", "id": "call-1", "name": "read", "args": "{}"})
	step(false, "tool_call", map[string]any{"run_id": "run", "id": "call-2", "name": "read", "args": "{}"})
	step(false, "tool_result", map[string]any{"run_id": "run", "id": "call-1", "content": "one"})
	step(true, "tool_result", map[string]any{"run_id": "run", "id": "call-2", "content": "two"})
	step(true, "chunk", map[string]any{"run_id": "run", "display_segment_id": "s2", "content": "answer", agentrun.DisplaySegmentOffsetKey: 0})
	// Without an offset the part cannot be rejoined to its history prefix.
	step(false, "thinking", map[string]any{"run_id": "run", "content": "unstamped"})
	step(true, "chunk", map[string]any{"run_id": "run", "display_segment_id": "s3", "content": "again", agentrun.DisplaySegmentOffsetKey: 0})
	step(false, "done", map[string]any{})
}
