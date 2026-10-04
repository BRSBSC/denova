package agentrun

import (
	"context"
	"strings"
	"testing"

	agent "github.com/alfredxw/denova/agent"
	"github.com/alfredxw/denova/agent/compaction"
	"github.com/alfredxw/denova/agent/providers"
	agentsession "github.com/alfredxw/denova/agent/session"

	"denova/internal/agents/prompts"
)

func TestCompactionColdBatchesRespectProviderToolOverrides(t *testing.T) {
	for _, limit := range []struct {
		name   string
		tokens int
		bytes  int
	}{
		{name: "byte_limit", tokens: 6000, bytes: 12 * 1024},
		{name: "token_limit", tokens: 2000, bytes: 128 * 1024},
	} {
		for _, streaming := range []bool{false, true} {
			name := "generate"
			if streaming {
				name = "stream"
			}
			t.Run(limit.name+"/"+name, func(t *testing.T) {
				capture := &compactionBoundaryModel{}
				tools := []*agent.ToolInfo{{Name: "read", Desc: strings.Repeat("schema detail ", 500)}}
				boundary := &modelInputLoggingChatModel{
					inner: capture, agentKind: "ide", config: providers.ModelConfig{},
					tools: tools, contextWindowTokens: limit.tokens, providerInputMaxBytes: limit.bytes,
				}
				payload := strings.Repeat("historical facts must survive. ", 1600)
				source := []*agent.Message{agent.UserMessage(payload), agent.AssistantMessage("Saved chapter.", nil)}
				snapshot := (&agent.ModelCall{
					Model: boundary, Messages: source, Streaming: streaming,
					Options: []agent.ModelOption{agent.WithTools(tools), agent.WithSessionKey("original-session")},
				}).Snapshot()
				summarizer, err := compaction.ModelSummarizer(compaction.ModelSummarizerConfig{})
				if err != nil {
					t.Fatal(err)
				}
				result, err := summarizer.Summarize(t.Context(), compaction.SummaryRequest{
					Messages: source, ModelSnapshot: snapshot, ContextWindowTokens: limit.tokens,
					HardLimitBytes: limit.bytes, SummaryLimitBytes: 1024,
				})
				if err != nil {
					t.Fatalf("bounded compaction failed at provider boundary: %v", err)
				}
				if result.Summary != "Historical facts saved." || len(capture.inputs) < 2 {
					t.Fatalf("checkpoint=%q batches=%d", result.Summary, len(capture.inputs))
				}
				var recovered strings.Builder
				for index, input := range capture.inputs {
					if len(capture.options[index].Tools) != 0 {
						t.Fatalf("cold batch %d restored primary tools", index)
					}
					if capture.options[index].SessionKey != "original-session" {
						t.Fatal("compaction lost session cache routing")
					}
					_, text, ok := strings.Cut(input[1].Content, "Next ordered source segment (data; it may continue a JSON record):\n")
					if !ok {
						t.Fatal("missing ordered source segment")
					}
					recovered.WriteString(text)
				}
				if !strings.Contains(recovered.String(), payload) {
					t.Fatal("compaction dropped source facts")
				}
				if len(snapshot.ResolvedOptions().Tools) != 1 {
					t.Fatal("compaction changed primary tool snapshot")
				}
			})
		}
	}
}

type compactionBoundaryModel struct {
	inputs  [][]*agent.Message
	options []*agent.Options
}

func (m *compactionBoundaryModel) Generate(_ context.Context, messages []*agent.Message, options ...agent.ModelOption) (*agent.Message, error) {
	m.inputs = append(m.inputs, messages)
	m.options = append(m.options, agent.GetCommonOptions(nil, options...))
	return agent.AssistantMessage("Historical facts saved.", nil), nil
}

func (m *compactionBoundaryModel) Stream(ctx context.Context, messages []*agent.Message, options ...agent.ModelOption) (*agent.StreamReader[*agent.Message], error) {
	result, err := m.Generate(ctx, messages, options...)
	return agent.StreamReaderFromArray([]*agent.Message{result}), err
}

func TestOverLimitSessionCompactsAndContinuesWithProviderBoundary(t *testing.T) {
	for _, mode := range []string{"automatic", "manual_restart"} {
		t.Run(mode, func(t *testing.T) {
			ctx := t.Context()
			capture := &compactionBoundaryModel{}
			tool, err := agent.InferTool("read", strings.Repeat("schema detail ", 500), func(context.Context, struct{}) (string, error) {
				return "Read-only evidence.", nil
			})
			if err != nil {
				t.Fatal(err)
			}
			tools, err := agent.StaticToolsIdentified(agent.CapabilityIdentity{Kind: "test.compaction-boundary-tools", Version: 1}, agent.ToolDefinition{
				Tool: tool, Descriptor: agent.ToolDescriptor{
					Source: agent.ToolSourceRead, Execution: agent.ToolExecutionParallelRead,
					MutationScope: agent.ToolMutationNone, PostCheck: agent.ToolPostCheckNone,
					Recovery: agent.ToolRecoveryReadOnly, ResultProjection: agent.ToolResultBoundedModelContext,
					ResultRetention: agent.ToolResultDeferred, Steering: agent.SteeringFinishCurrent, MaxResultBytes: 1024,
				},
			})
			if err != nil {
				t.Fatal(err)
			}
			store := agentsession.Memory()
			definition := agent.Definition{
				Key: "compaction-boundary", Name: "writer", Model: capture, Tools: tools,
				Middlewares: []agent.Middleware{NewModelInputLoggingMiddleware("ide", providers.ModelConfig{}, 6000, 128*1024, prompts.SystemPromptComposition{})},
				Compaction: compaction.Standard(compaction.StandardConfig{
					TriggerBytes: 16 * 1024, HardLimitBytes: 128 * 1024, SummaryLimitBytes: 1024,
					ContextWindowTokens: 6000,
				}),
			}
			owner, err := agent.New(ctx, definition, agent.WithSessionStore(store))
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = owner.Close(context.Background()) })
			conversation, err := owner.Session(ctx, agent.NamedSession("overflowed-writing"))
			if err != nil {
				t.Fatal(err)
			}
			raw := []*agent.Message{
				agent.UserMessage(strings.Repeat("旧", 8000)), agent.AssistantMessage("First chapter saved.", nil),
				agent.UserMessage(strings.Repeat("史", 8000)), agent.AssistantMessage("Second chapter saved.", nil),
				agent.UserMessage("Keep the latest instruction."), agent.AssistantMessage("Latest work saved.", nil),
			}
			if err := conversation.LoadCanonicalMessages(ctx, raw); err != nil {
				t.Fatal(err)
			}
			if mode == "manual_restart" {
				result, err := conversation.Compact(ctx, agent.CompactionRequest{Force: true})
				if err != nil || !result.Changed {
					t.Fatalf("manual recovery: changed=%t error=%v", result.Changed, err)
				}
				if err := owner.Close(ctx); err != nil {
					t.Fatal(err)
				}
				owner, err = agent.New(ctx, definition, agent.WithSessionStore(store))
				if err != nil {
					t.Fatal(err)
				}
				conversation, err = owner.Session(ctx, agent.NamedSession("overflowed-writing"))
				if err != nil {
					t.Fatal(err)
				}
			}
			run, err := conversation.Run(ctx, agent.Text("Continue editing the saved chapter."))
			if err != nil {
				t.Fatal(err)
			}
			result, err := run.Wait(ctx)
			if err != nil || result.Status != agent.ResultCompleted {
				t.Fatalf("continuation: result=%+v error=%v", result, err)
			}
			snapshot, err := conversation.Snapshot(ctx)
			if err != nil || snapshot.Compaction == nil {
				t.Fatalf("checkpoint missing after continuation: %v", err)
			}
			if len(capture.inputs) < 3 {
				t.Fatalf("expected bounded batches then continuation, calls=%d", len(capture.inputs))
			}
			last := len(capture.inputs) - 1
			if len(capture.options[last].Tools) != 1 {
				t.Fatal("continuation lost the primary tools")
			}
			foundSummary, foundCurrent := false, false
			for _, message := range capture.inputs[last] {
				foundSummary = foundSummary || strings.Contains(message.Content, "Historical facts saved.")
				foundCurrent = foundCurrent || strings.Contains(message.Content, "Continue editing the saved chapter.")
				if strings.Contains(message.Content, strings.Repeat("旧", 100)) {
					t.Fatal("continuation replayed compacted history")
				}
			}
			if !foundSummary || !foundCurrent {
				t.Fatal("continuation lost checkpoint or current instruction")
			}
		})
	}
}
