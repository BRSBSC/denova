package engine

import (
	"encoding/json"
	"errors"

	agenthistory "github.com/alfredxw/denova/agent/context/history"
)

// encodeCanonicalWindow retains only the bodies needed by the accepted
// compaction projection. Direct imports without an archive source stay whole.
func encodeCanonicalWindow(state engineTranscript, capabilities map[string]json.RawMessage) (json.RawMessage, error) {
	if state.HistoryHead.Identity == "" && state.Archive == nil {
		return json.Marshal(state)
	}
	clear, clearPresent, err := agenthistory.ClearStateFrom(capabilities)
	if err != nil {
		return nil, err
	}
	compact, present, err := agenthistory.CompactionStateFrom(capabilities)
	if err != nil {
		return nil, err
	}
	compact, present = agenthistory.ClearCompaction(compact, present, clear, clearPresent)
	if state.HistoryHead.Identity != "" && present && !compact.Removed {
		state.Messages, state.Archive = agenthistory.ArchiveHistory(state.Messages, state.Archive, compact, state.ContextState)
	}
	if state.Archive != nil && (!present || compact.Removed) {
		return nil, errors.New("canonical archive requires its accepted compaction")
	}
	state.Version = transcriptVersion(state.Archive)
	return json.Marshal(state)
}
