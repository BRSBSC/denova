package anthropicmessages

import (
	"errors"
	"net/http"
	"strings"

	"github.com/alfredxw/denova/agent/model/providers"
	"github.com/anthropics/anthropic-sdk-go"
)

func adaptAPIError(err error) error {
	if err == nil {
		return nil
	}
	var providerError *providers.APIError
	if errors.As(err, &providerError) {
		return err
	}
	var sdkError *anthropic.Error
	if !errors.As(err, &sdkError) {
		return err
	}
	return &providers.APIError{
		StatusCode: sdkError.StatusCode,
		// The SDK reports stream error events with the accepted response status.
		InStream: sdkError.StatusCode < http.StatusBadRequest,
		Kind:     string(sdkError.Type()), RetryAfter: providers.RetryAfterDelay(sdkError.Response),
		RequestID: sdkError.RequestID,
		Message:   strings.TrimSpace(err.Error()),
		Cause:     err,
	}
}
