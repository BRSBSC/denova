package lifecycle

import (
	"context"
	"encoding/json"
	"time"

	agenthistory "github.com/alfredxw/denova/agent/context/history"
	agentexecution "github.com/alfredxw/denova/agent/engine/execution"
	agentevent "github.com/alfredxw/denova/agent/lifecycle/event"
)

func (session *Session) Clear(ctx context.Context) error {
	if err := session.usable(); err != nil {
		return err
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	raw, present := session.capabilities[agenthistory.ClearCapability]
	var state agenthistory.ClearState
	var err error
	if present {
		state, err = agenthistory.DecodeClearState(raw)
		if err != nil {
			return err
		}
	}
	compaction, compactionPresent, err := agenthistory.CompactionStateFrom(session.capabilities)
	if err != nil {
		return err
	}
	state.Revision++
	state.ClearedAt = time.Now().UTC()
	if compactionPresent {
		state.CompactionRevisionAtClear = compaction.Revision
	}
	encoded, err := json.Marshal(state)
	if err != nil {
		return err
	}
	// Todo belongs to the cleared conversation. Goal intentionally survives so
	// a user-controlled long-running objective can continue into the fresh transcript.
	for _, capability := range []string{agentexecution.TodoCapability, agenthistory.CompactionHealthCapability, agenthistory.ElisionCapability} {
		delete(session.capabilities, capability)
	}
	session.capabilities[agenthistory.ClearCapability] = encoded
	if err := session.persistCapabilitiesLocked(ctx); err != nil {
		return err
	}
	session.publishLocked(agentevent.Event{Payload: agentevent.SessionCleared{Revision: state.Revision}})
	return nil
}
