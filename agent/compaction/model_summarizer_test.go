package compaction

import (
	"context"
	"errors"
	agent "github.com/alfredxw/denova/agent"
	"reflect"
	"strings"
	"testing"
)

type summaryCaptureModel struct {
	inputs   [][]*agent.Message
	options  []*agent.Options
	response *agent.Message
	err      error
}

func (m *summaryCaptureModel) Generate(_ context.Context, messages []*agent.Message, options ...agent.ModelOption) (*agent.Message, error) {
	m.inputs = append(m.inputs, cloneMessages(messages))
	m.options = append(m.options, agent.GetCommonOptions(nil, options...))
	return m.response, m.err
}
func (m *summaryCaptureModel) Stream(ctx context.Context, messages []*agent.Message, options ...agent.ModelOption) (*agent.StreamReader[*agent.Message], error) {
	result, err := m.Generate(ctx, messages, options...)
	return agent.StreamReaderFromArray([]*agent.Message{result}), err
}
func TestBuiltinSummaryUsesSnapshotAndNeverFallsBackAfterProviderFailure(t *testing.T) {
	for _, failure := range []string{"none", "provider", "tool", "oversized", "mismatch"} {
		t.Run(failure, func(t *testing.T) {
			model := &summaryCaptureModel{response: agent.AssistantMessage("Checkpoint.", nil)}
			source := []*agent.Message{agent.UserMessage("original task"), agent.AssistantMessage("completed work", nil)}
			primary := append([]*agent.Message{agent.SystemMessage("stable system")}, source...)
			primary = append(primary, agent.UserMessage("latest"))
			options := []agent.ModelOption{agent.WithTools([]*agent.ToolInfo{{Name: "read"}}), agent.WithSessionKey("stable-cache"), agent.WithToolChoice(agent.ToolChoiceAllowed), agent.WithMaxTokens(12000)}
			snapshot := (&agent.ModelCall{Model: model, Messages: primary, Options: options}).Snapshot()
			switch failure {
			case "provider":
				model.err = errors.New("provider failed")
			case "tool":
				model.response = agent.AssistantMessage("", []agent.ToolCall{{ID: "unexpected", Function: agent.FunctionCall{Name: "read"}}})
			case "oversized":
				model.response = agent.AssistantMessage(strings.Repeat("too large ", 1000), nil)
			case "mismatch":
				source = []*agent.Message{agent.UserMessage("hidden source")}
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

func (m reasoningBudgetModel) Generate(_ context.Context, _ []*agent.Message, options ...agent.ModelOption) (*agent.Message, error) {
	if limit := agent.GetCommonOptions(nil, options...).MaxTokens; limit != nil && *limit <= m.reasoningTokens {
		message := agent.AssistantMessage("", nil)
		message.ReasoningContent = "still reasoning"
		message.ResponseMeta = &agent.ResponseMeta{FinishReason: "length"}
		return message, nil
	}
	return agent.AssistantMessage("Checkpoint.", nil), nil
}
func (m reasoningBudgetModel) Stream(ctx context.Context, messages []*agent.Message, options ...agent.ModelOption) (*agent.StreamReader[*agent.Message], error) {
	result, err := m.Generate(ctx, messages, options...)
	return agent.StreamReaderFromArray([]*agent.Message{result}), err
}

func TestSummaryCallLeavesTheModelResponseCapForReasoning(t *testing.T) {
	model := reasoningBudgetModel{reasoningTokens: 8192}
	source := []*agent.Message{agent.UserMessage("original task"), agent.AssistantMessage("completed work", nil)}
	primary := append(append([]*agent.Message{agent.SystemMessage("stable system")}, source...), agent.UserMessage("latest"))
	snapshot := (&agent.ModelCall{Model: model, Messages: primary, Options: []agent.ModelOption{agent.WithMaxTokens(64000)}}).Snapshot()
	for name, config := range map[string]ModelSummarizerConfig{"prefix": {}, "cold": {Model: model, Identity: agent.CapabilityIdentity{Kind: "test.summary", Version: 1, ConfigHash: "cold"}}} {
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
