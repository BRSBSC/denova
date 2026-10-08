package api

import (
	"net/http"
	"testing"
)

func TestBookCreationReportsAnExistingDirectoryAsConflict(t *testing.T) {
	server := NewServer(newTestApplication(t), "0")
	body := map[string]string{"title": "Twice Created"}
	if first := performJSONRequest(t, server, http.MethodPost, "/api/books/create", body); first.Code != http.StatusOK {
		t.Fatalf("first creation status=%d body=%s", first.Code, first.Body.String())
	}
	if second := performJSONRequest(t, server, http.MethodPost, "/api/books/create", body); second.Code != http.StatusConflict {
		t.Fatalf("second creation status=%d body=%s", second.Code, second.Body.String())
	}
}
