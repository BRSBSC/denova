package openaiclient

import (
	"encoding/json"
	"errors"
	"strings"

	"github.com/openai/openai-go/v3/packages/ssestream"

	"github.com/alfredxw/denova/agent/model/providers"
)

// AdaptStreamError converts an error event received inside an accepted stream
// into the protocol-neutral provider error so retry policy can classify it.
// Any other error is returned unchanged.
func AdaptStreamError(err error) error {
	var streamError *ssestream.StreamError
	if !errors.As(err, &streamError) {
		return err
	}
	var payload struct {
		Error struct {
			Type string `json:"type"`
			Code any    `json:"code"`
		} `json:"error"`
	}
	// Custom endpoints also send a bare string error or a numeric code; those
	// stay unclassified and fall back to the in-stream default.
	_ = json.Unmarshal(streamError.Event.Data, &payload)
	code, _ := payload.Error.Code.(string)
	return &providers.APIError{
		Code: code, Kind: payload.Error.Type, InStream: true,
		Message: strings.TrimSpace(err.Error()),
		Cause:   err,
	}
}
