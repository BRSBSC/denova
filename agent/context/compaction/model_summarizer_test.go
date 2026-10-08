package compaction

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	agentmodel "github.com/alfredxw/denova/agent/model"
	agentstream "github.com/alfredxw/denova/agent/model/stream"
	agentschema "github.com/alfredxw/denova/agent/schema"
)

type summaryCaptureModel struct {
	inputs   [][]*agentschema.Message
	options  []*agentmodel.Options
	response *agentschema.Message
	err      error
}

func (m *summaryCaptureModel) Generate(_ context.Context, messages []*agentschema.Message, options ...agentmodel.ModelOption) (*agentschema.Message, error) {
	m.inputs = append(m.inputs, cloneMessages(messages))
	m.options = append(m.options, agentmodel.GetCommonOptions(nil, options...))
	return m.response, m.err
}
func (m *summaryCaptureModel) Stream(ctx context.Context, messages []*agentschema.Message, options ...agentmodel.ModelOption) (*agentstream.StreamReader[*agentschema.Message], error) {
	result, err := m.Generate(ctx, messages, options...)
	return agentstream.StreamReaderFromArray([]*agentschema.Message{result}), err
}
func TestBuiltinSummaryUsesSnapshotAndNeverFallsBackAfterProviderFailure(t *testing.T) {
	for _, failure := range []string{"none", "provider", "tool", "oversized", "mismatch"} {
		t.Run(failure, func(t *testing.T) {
			model := &summaryCaptureModel{response: agentschema.AssistantMessage("Checkpoint.", nil)}
			source := []*agentschema.Message{agentschema.UserMessage("original task"), agentschema.AssistantMessage("completed work", nil)}
			primary := append([]*agentschema.Message{agentschema.SystemMessage("stable system")}, source...)
			primary = append(primary, agentschema.UserMessage("latest"))
			options := []agentmodel.ModelOption{agentmodel.WithTools([]*agentschema.ToolInfo{{Name: "read"}}), agentmodel.WithSessionKey("stable-cache"), agentmodel.WithToolChoice(agentmodel.ToolChoiceAllowed), agentmodel.WithMaxTokens(12000)}
			snapshot := (&agentmodel.ModelCall{Model: model, Messages: primary, Options: options}).Snapshot()
			switch failure {
			case "provider":
				model.err = errors.New("provider failed")
			case "tool":
				model.response = agentschema.AssistantMessage("", []agentschema.ToolCall{{ID: "unexpected", Function: agentschema.FunctionCall{Name: "read"}}})
			case "oversized":
				model.response = agentschema.AssistantMessage(strings.Repeat("too large ", 1000), nil)
			case "mismatch":
				source = []*agentschema.Message{agentschema.UserMessage("hidden source")}
			}
			summarizer, err := ModelSummarizer(ModelSummarizerConfig{})
			if err != nil {
				t.Fatal(err)
			}
			result, err := summarizer.Summarize(t.Context(), SummaryRequest{Messages: source, ModelSnapshot: snapshot, ContextWindowTokens: 16000, SummaryLimitBytes: 4096, HardLimitBytes: 1 << 20})
			if failure == "none" {
				if err != nil || result.Summary != "Checkpoint." {
					t.Fatalf("result=%#v err=%v", result, err)
				}
			} else if err == nil {
				t.Fatal("invalid checkpoint accepted")
			}
			if failure == "mismatch" {
				if len(model.inputs) != 0 {
					t.Fatal("hidden source sent to model")
				}
				return
			}
			if len(model.inputs) != 1 || !reflect.DeepEqual(model.inputs[0][:len(primary)], primary) {
				t.Fatal("fork changed prefix or retried as cold call")
			}
			if !reflect.DeepEqual(model.options[0].Tools, snapshot.ResolvedOptions().Tools) || model.options[0].SessionKey != snapshot.ResolvedOptions().SessionKey {
				t.Fatal("fork changed captured options")
			}
			if !reflect.DeepEqual(snapshot.Messages(), primary) {
				t.Fatal("primary snapshot mutated")
			}
		})
	}
}

// reasoningBudgetModel spends its response cap on reasoning first, like
// providers whose output limit includes chain-of-thought tokens.
type reasoningBudgetModel struct{ reasoningTokens int }

func (m reasoningBudgetModel) Generate(_ context.Context, _ []*agentschema.Message, options ...agentmodel.ModelOption) (*agentschema.Message, error) {
	if limit := agentmodel.GetCommonOptions(nil, options...).MaxTokens; limit != nil && *limit <= m.reasoningTokens {
		message := agentschema.AssistantMessage("", nil)
		message.ReasoningContent = "still reasoning"
		message.ResponseMeta = &agentschema.ResponseMeta{FinishReason: "length"}
		return message, nil
	}
	return agentschema.AssistantMessage("Checkpoint.", nil), nil
}
func (m reasoningBudgetModel) Stream(ctx context.Context, messages []*agentschema.Message, options ...agentmodel.ModelOption) (*agentstream.StreamReader[*agentschema.Message], error) {
	result, err := m.Generate(ctx, messages, options...)
	return agentstream.StreamReaderFromArray([]*agentschema.Message{result}), err
}

func TestSummaryCallLeavesTheModelResponseCapForReasoning(t *testing.T) {
	model := reasoningBudgetModel{reasoningTokens: 8192}
	source := []*agentschema.Message{agentschema.UserMessage("original task"), agentschema.AssistantMessage("completed work", nil)}
	primary := append(append([]*agentschema.Message{agentschema.SystemMessage("stable system")}, source...), agentschema.UserMessage("latest"))
	snapshot := (&agentmodel.ModelCall{Model: model, Messages: primary, Options: []agentmodel.ModelOption{agentmodel.WithMaxTokens(64000)}}).Snapshot()
	for name, config := range map[string]ModelSummarizerConfig{"prefix": {}, "cold": {Model: model, Identity: agentschema.CapabilityIdentity{Kind: "test.summary", Version: 1, ConfigHash: "cold"}}} {
		t.Run(name, func(t *testing.T) {
			summarizer, err := ModelSummarizer(config)
			if err != nil {
				t.Fatal(err)
			}
			result, err := summarizer.Summarize(t.Context(), SummaryRequest{Messages: source, ModelSnapshot: snapshot, ContextWindowTokens: 1_000_000, SummaryLimitBytes: 64 << 10, HardLimitBytes: 4 << 20})
			if err != nil || result.Summary != "Checkpoint." {
				t.Fatalf("result=%#v err=%v", result, err)
			}
		})
	}
}
