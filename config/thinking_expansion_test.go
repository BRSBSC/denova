package config

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

func TestThinkingExpansionPreferencePersistsAndInherits(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	settings := Settings{Theme: "dark"}
	for _, patch := range []string{`{"auto_expand_thinking":true}`, `{"auto_expand_thinking":false}`, `{"auto_expand_thinking":null}`} {
		next, err := ApplySettingsMergePatch(settings, json.RawMessage(patch))
		if err != nil {
			t.Fatal(err)
		}
		if err := WriteSettingsFile(path, next); err != nil {
			t.Fatal(err)
		}
		stored, err := ReadSettingsFile(path)
		if err != nil {
			t.Fatal(err)
		}
		effective := Merge(DefaultSettings(), stored)
		data, err := json.Marshal(effective)
		if err != nil {
			t.Fatal(err)
		}
		var fields map[string]any
		if err := json.Unmarshal(data, &fields); err != nil {
			t.Fatal(err)
		}
		expected := patch == `{"auto_expand_thinking":true}`
		if fields["auto_expand_thinking"] != expected || effective.Theme != "dark" {
			t.Fatalf("preference did not survive persistence and inheritance: %s", data)
		}
		settings = stored
	}
	if err := ValidateWorkspaceSettingsPatch(json.RawMessage(`{"auto_expand_thinking":true}`)); err == nil {
		t.Fatal("display preference must remain user-scoped")
	}
}
