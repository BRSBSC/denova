package canonical

import (
	"context"

	agentschema "github.com/alfredxw/denova/agent/schema"
)

// CanonicalHistoryHead identifies the immutable product lane and its current
// model-visible revision. Revision must use the same identity as CommitReceipt;
// display-only appends must not advance it. Neither field may contain host paths.
// Identity must change on Clear or any edit/reordering of an existing prefix,
// including edits to messages currently covered by a compaction checkpoint.
type CanonicalHistoryHead struct {
	Identity string `json:"identity"`
	Revision string `json:"revision"`
}

// CanonicalHistorySource owns the full history needed for reconstruction and
// explicit compaction removal. Aligned checkpoints need only the cheap head.
// Read and Head must observe one canonical lane, including external edits/Clear.
type CanonicalHistorySource interface {
	CanonicalHistoryHead(context.Context) (CanonicalHistoryHead, error)
	CanonicalMessages(context.Context) ([]*agentschema.Message, error)
}
