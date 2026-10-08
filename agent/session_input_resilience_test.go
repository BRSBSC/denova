package agent

import (
	"context"
	"errors"
	"testing"

	agentsession "github.com/alfredxw/denova/agent/session"
)

func TestSessionQueuesInputAcrossCloseWithoutStartingModel(t *testing.T) {
	store := agentsession.Memory()
	model := &lifecycleModel{responses: []*Message{AssistantMessage("first", nil), AssistantMessage("supplement", nil)}}
	open := func() (*Agent, *Session) {
		owner, err := New(context.Background(), Definition{Name: "test", Model: model}, WithSessionStore(store))
		if err != nil {
			t.Fatal(err)
		}
		session, err := owner.Session(context.Background(), NamedSession("inbox"))
		if err != nil {
			t.Fatal(err)
		}
		return owner, session
	}
	owner, session := open()
	input := Input{Text: "remember this", IdempotencyKey: "message-1"}
	queued, err := session.Queue(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	receipt := queued.Receipt()
	if err := owner.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	owner, session = open()
	t.Cleanup(func() { _ = owner.Close(context.Background()) })
	if len(model.calls()) != 0 {
		t.Fatal("opening the inbox called the model")
	}
	duplicate, err := session.Queue(context.Background(), input)
	if err != nil || duplicate.Receipt() != receipt {
		t.Fatalf("receipt=%#v err=%v", duplicate, err)
	}
	input.Text = "different content"
	if _, err := session.Queue(context.Background(), input); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("conflicting command error=%v", err)
	}
	run, err := session.Run(context.Background(), Input{Text: "start", IdempotencyKey: "start-1"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := run.Wait(context.Background()); err != nil {
		t.Fatal(err)
	}
	calls := model.calls()
	if len(calls) != 2 || calls[1][len(calls[1])-1].Content != "remember this" {
		t.Fatalf("provider calls=%#v", calls)
	}
	if _, err := duplicate.Cancel(context.Background(), QueueControlRequest{IdempotencyKey: "cancel-consumed"}); !errors.Is(err, ErrInputConsumed) {
		t.Fatalf("consumed cancellation=%v", err)
	}
}

func TestSessionFollowUpReturnsDurableRunReceipt(t *testing.T) {
	model := &lifecycleModel{responses: []*Message{AssistantMessage("done", nil)}}
	owner, err := New(context.Background(), Definition{Name: "test", Model: model})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = owner.Close(context.Background()) })
	session, err := owner.Session(context.Background(), NamedSession("follow-up"))
	if err != nil {
		t.Fatal(err)
	}
	input := Input{Text: "new task", IdempotencyKey: "task-1"}
	receipt, err := session.FollowUp(context.Background(), input)
	if err != nil || receipt.RunID == "" {
		t.Fatalf("receipt=%#v err=%v", receipt, err)
	}
	run, found, err := session.AttachRun(context.Background(), receipt.RunID)
	if err != nil || !found {
		t.Fatalf("attach found=%v err=%v", found, err)
	}
	if _, err := run.Wait(context.Background()); err != nil {
		t.Fatal(err)
	}
	again, err := session.FollowUp(context.Background(), input)
	if err != nil || again != receipt || len(model.calls()) != 1 {
		t.Fatalf("repeat=%#v err=%v calls=%d", again, err, len(model.calls()))
	}
}

func TestQueuedControlsRemainScopedAfterTheirRunIsAborted(t *testing.T) {
	ctx := t.Context()
	model := &gatedLifecycleModel{started: make(chan struct{}), release: make(chan struct{})}
	owner, err := New(ctx, Definition{Name: "queue-controls", Model: model})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = owner.Close(context.Background()) })
	key := NamedSession("old-queue")
	sess, err := owner.Session(ctx, key)
	if err != nil {
		t.Fatal(err)
	}
	run, err := sess.Run(ctx, Input{Text: "task A", IdempotencyKey: "start-a"})
	if err != nil {
		t.Fatal(err)
	}
	<-model.started
	queued, err := sess.Queue(ctx, Input{Text: "old instruction", IdempotencyKey: "queued-a"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := owner.SuspendTree(ctx, key, SuspendRequest{RunID: run.ID(), IdempotencyKey: "pause-a"}); err != nil {
		t.Fatal(err)
	}
	sess, err = owner.Session(ctx, key)
	if err != nil {
		t.Fatal(err)
	}
	queued, found, err := sess.Queued(ctx, "queued-a")
	if err != nil || !found {
		t.Fatalf("queued input after pause: found=%v error=%v", found, err)
	}
	steer := QueueControlRequest{IdempotencyKey: "steer-a"}
	receipt, err := queued.Interrupt(ctx, steer)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := owner.AbortTree(ctx, key, AbortRequest{IdempotencyKey: "abort-a"}); err != nil {
		t.Fatal(err)
	}
	sess, err = owner.Session(ctx, key)
	if err != nil {
		t.Fatal(err)
	}
	queued, found, err = sess.Queued(ctx, "queued-a")
	if err != nil || !found {
		t.Fatalf("queued input after abort: found=%v error=%v", found, err)
	}
	if retried, err := queued.Interrupt(ctx, steer); err != nil || retried != receipt {
		t.Fatalf("accepted steer retry: receipt=%#v error=%v", retried, err)
	}
	for _, phase := range []string{"idle", "running"} {
		if phase == "running" {
			if _, err := sess.Run(ctx, Input{Text: "task B", IdempotencyKey: "start-b"}); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := queued.Interrupt(ctx, QueueControlRequest{IdempotencyKey: "stale-steer-" + phase}); !errors.Is(err, ErrRunSettled) {
			t.Fatalf("stale steer while %s: error=%v, want settled run", phase, err)
		}
	}
	control := QueueControlRequest{IdempotencyKey: "cancel-a"}
	if cancelled, err := queued.Cancel(ctx, control); err != nil || cancelled.RunID != run.ID() {
		t.Fatalf("cancel old input: receipt=%#v error=%v", cancelled, err)
	}
	snapshot, err := sess.Snapshot(ctx)
	if err != nil || snapshot.ActiveRunID == run.ID() || snapshot.ActiveRunID == "" || len(snapshot.QueuedRuns) != 0 {
		t.Fatalf("task B after old input cancellation: snapshot=%#v error=%v", snapshot, err)
	}
}
