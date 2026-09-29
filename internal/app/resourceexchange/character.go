package resourceexchange

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"

	"denova/internal/book/character"
	"denova/internal/book/lore"
	"denova/internal/revisionfile"
)

// Character conversion uses the existing adapter in an isolated workspace. The
// converted resources enter exactly the same frozen preview as native bundles.
func (s *Service) previewCharacter(ctx context.Context, source Source, data []byte) (Preview, error) {
	return s.PreviewCharacter(ctx, source, data, character.ImportOptions{ClassificationMode: lore.ClassificationModeHeuristic})
}

// PreviewCharacter freezes the result of optional semantic classification once.
// Applying or reloading the plan never invokes the classifier again.
func (s *Service) PreviewCharacter(ctx context.Context, source Source, data []byte, options character.ImportOptions) (Preview, error) {
	dir, err := os.MkdirTemp("", "denova-card-")
	if err != nil {
		return Preview{}, err
	}
	defer os.RemoveAll(dir)
	result, err := character.NewService(dir).ImportTavernCard(source.Filename, data, options)
	if err != nil {
		return Preview{}, err
	}
	items, err := lore.NewStore(dir).ListAll()
	if err != nil {
		return Preview{}, err
	}
	manifest := Manifest{Format: "denova.resource-pack", SchemaVersion: 1, Package: PackageInfo{ID: "character-card", Name: result.Name}}
	files := map[string][]byte{}
	collection := portableCollection[json.RawMessage]{Version: 1, Items: []json.RawMessage{}}
	for _, item := range items {
		raw, err := portableJSON("lore.entry", item)
		if err != nil {
			return Preview{}, err
		}
		collection.Items = append(collection.Items, raw)
	}
	if len(collection.Items) > 0 {
		files["lore.json"], err = json.Marshal(collection)
		if err != nil {
			return Preview{}, err
		}
		manifest.Resources = append(manifest.Resources, Resource{ID: "lore", Kind: "lore.collection", Path: "lore.json"})
	}
	if result.OpeningPresetCount > 0 {
		raw, err := os.ReadFile(filepath.Join(dir, "setting", "interactive-openings.json"))
		if err != nil {
			return Preview{}, err
		}
		var native openings
		if err := json.Unmarshal(raw, &native); err != nil {
			return Preview{}, err
		}
		files["openings.json"], err = json.Marshal(portableCollection[opening]{Version: 1, Items: native.Presets})
		if err != nil {
			return Preview{}, err
		}
		manifest.Resources = append(manifest.Resources, Resource{ID: "openings", Kind: "game.openings", Path: "openings.json"})
	}
	if result.CoverPath != "" {
		raw, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(result.CoverPath)))
		if err != nil {
			return Preview{}, err
		}
		files["cover.png"] = raw
		files["cover.json"] = []byte(`{"asset_path":"cover.png"}`)
		manifest.Resources = append(manifest.Resources, Resource{ID: "cover", Kind: "project.cover", Path: "cover.json", Assets: []string{"cover.png"}})
	}
	raw, err := json.Marshal(manifest)
	if err != nil {
		return Preview{}, err
	}
	files["denova-pack.json"] = raw
	preview, err := s.previewFiles(ctx, Source{Kind: "file", Filename: filepath.Base(source.Filename)}, files)
	if err != nil {
		return Preview{}, err
	}
	result.Workspace, result.TargetPath, result.ProjectID, result.ItemIDs = "", "", "", nil
	preview.Character = &result
	directory, _ := s.previewPath(preview.ID)
	raw, err = json.Marshal(preview)
	if err != nil {
		return Preview{}, err
	}
	_, err = revisionfile.ReplaceIfRevision(ctx, filepath.Join(directory, "preview.json"), "", raw, revisionfile.Options{})
	return preview, err
}
