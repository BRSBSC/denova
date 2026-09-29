package resourceexchange

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"denova/internal/book/lore"
	"denova/internal/platform"
	"denova/internal/project"
)

func TestLoreCollectionLifecycle(t *testing.T) {
	ctx := context.Background()
	s := testService(t)
	dir := filepath.Join(s.root, "projects", "collection")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	record, err := s.registry.Add(dir, project.TypeBook, "Collection")
	if err != nil {
		t.Fatal(err)
	}
	store := lore.NewStore(dir)
	if _, err := store.Create(lore.ItemInput{ID: "personal", Name: "Personal", Content: "My notes"}); err != nil {
		t.Fatal(err)
	}
	collection := portableCollection[json.RawMessage]{Version: 1}
	for i := 0; i < 300; i++ {
		collection.Items = append(collection.Items, jsonBytes(t, map[string]any{"id": fmt.Sprintf("item-%d", i), "name": fmt.Sprintf("Item %d", i), "type": "world", "content": fmt.Sprintf("Setting %d", i)}))
	}
	manifest := Manifest{Format: "denova.resource-pack", SchemaVersion: 1, Package: PackageInfo{ID: "world", Name: "World"}, Resources: []Resource{{ID: "lore", Kind: "lore.collection", Path: "lore.json"}, {ID: "opening", Kind: "game.openings", Path: "opening.json", Requires: []string{"lore"}}}}
	preview := func() Preview {
		t.Helper()
		p, err := s.previewFiles(ctx, Source{Kind: "file", Filename: "world.zip"}, map[string][]byte{"denova-pack.json": jsonBytes(t, manifest), "lore.json": jsonBytes(t, collection), "opening.json": []byte(`{"version":1,"items":[{"id":"arrival","title":"Arrival","content":"You arrive."}]}`)})
		if err != nil {
			t.Fatal(err)
		}
		return p
	}
	p := preview()
	if len(p.Candidates[0].Resources) != 2 || p.Candidates[0].Resources[0].ItemCount != 300 {
		t.Fatalf("collection exploded into resources: %+v", p)
	}
	filesPreview, err := s.PreviewFiles(ctx, p.ID, p.Candidates[0].ID, "lore", "lore.json", "item-299")
	if err != nil || len(filesPreview.Items) != 300 || filesPreview.Truncated {
		t.Fatal("collection preview", err)
	}
	var previewItem lore.ItemInput
	if err := json.Unmarshal([]byte(filesPreview.Content), &previewItem); err != nil || previewItem.ID != "item-299" {
		t.Fatal("wrong preview item", err)
	}
	if _, err := s.PreviewFiles(ctx, p.ID, p.Candidates[0].ID, "lore", "lore.json", "not-in-collection"); err == nil {
		t.Fatal("accepted missing item")
	}
	plan, err := s.Plan(ctx, PlanRequest{PreviewID: p.ID, CandidateID: p.Candidates[0].ID, Resources: []string{"opening"}, ProjectID: record.ID})
	if err != nil {
		t.Fatal(err)
	}
	installed, err := s.Apply(ctx, plan.ID)
	if err != nil {
		t.Fatal(err)
	}
	var binding Binding
	for _, b := range installed.Bindings {
		if b.Local.Kind == "lore.collection" {
			binding = b
		}
	}
	if len(binding.Members) != 300 {
		t.Fatal("lost member identities")
	}
	items, err := store.ListAll()
	if err != nil || len(items) != 301 {
		t.Fatal(len(items), err)
	}
	// Simulate a user edit captured by staging after an earlier live state read.
	// Admission must compare the exact staged snapshot, not read the live file again.
	snapshot, err := os.ReadFile(lore.ItemsPath(dir))
	if err != nil {
		t.Fatal(err)
	}
	var edited lore.Collection
	if err := json.Unmarshal(snapshot, &edited); err != nil {
		t.Fatal(err)
	}
	for i := range edited.Items {
		if edited.Items[i].ID == binding.Members["item-0"].ID {
			edited.Items[i].Content = "Edit captured by snapshot"
		}
	}
	staged := map[FileTarget][]byte{{ProjectID: record.ID, Path: lore.ItemsRelativePath}: jsonBytes(t, edited)}
	var extra []FileTarget
	copyBinding := binding
	err = s.stageLoreCollection(ctx, "", p.Candidates[0].Resources[0], &copyBinding, jsonBytes(t, collection), false, staged, &extra, map[FileTarget]lore.Asset{})
	if !errors.Is(err, ErrLocalModified) {
		t.Fatalf("staged edit not protected: %v", err)
	}
	exported, err := s.Export(ctx, ExportRequest{Package: installed.Package, InstallationID: installed.ID, Resources: []LocalRef{binding.Local}})
	if err != nil {
		t.Fatal(err)
	}
	files, err := platform.ArchiveFiles(exported)
	if err != nil || len(files) != 2 {
		t.Fatalf("expected only manifest and collection: %d %v", len(files), err)
	}
	var roundtrip Manifest
	if err := json.Unmarshal(files["denova-pack.json"], &roundtrip); err != nil {
		t.Fatal(err)
	}
	_, portableItems, err := readLoreCollection(files[roundtrip.Resources[0].Path])
	if err != nil || len(portableItems) != 300 || portableItems[0].ID != "item-0" {
		t.Fatal("roundtrip identities", len(portableItems), err)
	}
	if _, err := s.Export(ctx, ExportRequest{Package: installed.Package, Resources: []LocalRef{binding.Local, {Kind: "lore.collection", Scope: "project", ProjectID: record.ID, ID: "all"}}}); err == nil {
		t.Fatal("export accepted overlapping Lore collections")
	}
	var openingRef LocalRef
	for _, b := range installed.Bindings {
		if b.Local.Kind == "game.openings" {
			openingRef = b.Local
		}
	}
	withDependencies, err := s.Export(ctx, ExportRequest{Package: installed.Package, InstallationID: installed.ID, Resources: []LocalRef{openingRef}})
	if err != nil {
		t.Fatal(err)
	}
	dependentFiles, err := platform.ArchiveFiles(withDependencies)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(dependentFiles["denova-pack.json"], &roundtrip); err != nil {
		t.Fatal(err)
	}
	if len(roundtrip.Resources) != 2 {
		t.Fatal("export lost collection dependency")
	}
	for _, resource := range roundtrip.Resources {
		if resource.Kind == "game.openings" && (len(resource.Requires) != 1 || resource.Requires[0] != "lore") {
			t.Fatal("export changed dependency identity", resource)
		}
	}
	// Unrelated project edits must not block a collection update.
	if _, err := store.Update("personal", lore.ItemInput{Name: "Personal", Content: "Changed independently"}); err != nil {
		t.Fatal(err)
	}
	collection.Items = collection.Items[:299]
	collection.Items[0] = jsonBytes(t, map[string]any{"id": "item-0", "name": "Item 0", "type": "world", "content": "Updated setting"})
	p = preview()
	request := PlanRequest{PreviewID: p.ID, CandidateID: p.Candidates[0].ID, Resources: []string{"lore"}, InstallationID: installed.ID}
	updated, err := s.Plan(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Apply(ctx, updated.ID); err != nil {
		t.Fatal(err)
	}
	item, err := store.ReadAny(binding.Members["item-0"].ID)
	if err != nil || item.Content != "Updated setting" {
		t.Fatal(item, err)
	}
	if _, err := store.ReadAny(binding.Members["item-299"].ID); err != nil {
		t.Fatal("upstream removal deleted local content", err)
	}
	if _, err := store.Update(item.ID, lore.ItemInput{Name: item.Name, Content: "Personal edit"}); err != nil {
		t.Fatal(err)
	}
	p = preview()
	request.PreviewID = p.ID
	if _, err := s.Plan(ctx, request); !errors.Is(err, ErrLocalModified) {
		t.Fatalf("local edit not protected: %v", err)
	}
	request.ReplaceModified = true
	replaced, err := s.Plan(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Apply(ctx, replaced.ID); err != nil {
		t.Fatal(err)
	}
	restore, err := s.PlanRestore(ctx, replaced.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Apply(ctx, restore.ID); err != nil {
		t.Fatal(err)
	}
	item, err = store.ReadAny(item.ID)
	if err != nil || item.Content != "Personal edit" {
		t.Fatal("rollback lost edits", item, err)
	}
}

func TestLoreCollectionRejectsInvalidMembers(t *testing.T) {
	for _, raw := range []string{
		`{"version":1,"items":[]}`,
		`{"version":1,"items":[{"id":"../x","name":"Invalid ID"}]}`,
		`{"version":2,"items":[{"id":"a","name":"A"}]}`,
		`{"version":1,"items":[{"id":"a","name":"A"},{"id":"a","name":"B"}]}`,
		`{"version":1,"items":[{"id":"a","name":"A"},{"id":"b","name":"A"}]}`,
		`{"version":1,"items":[{"id":"a","name":"A","image":{"image_path":"/private/host.png"}}]}`,
	} {
		if err := validatePayload("lore.collection", []byte(raw)); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
}

func TestCollectionAcceptsNativeItemIdentitiesAndLargeCharacterCards(t *testing.T) {
	// IDs are data inside the collection, not filenames or manifest resource IDs.
	if _, _, err := readLoreCollection([]byte(`{"version":1,"items":[{"id":"人物-甲","name":"甲","content":"A character."}]}`)); err != nil {
		t.Fatal(err)
	}
	entries := make([]map[string]any, 300)
	for i := range entries {
		entries[i] = map[string]any{"id": i, "keys": []string{fmt.Sprintf("place-%d", i)}, "comment": fmt.Sprintf("Place %d", i), "content": "An independently readable place.", "enabled": true}
	}
	raw := jsonBytes(t, map[string]any{"spec": "chara_card_v2", "data": map[string]any{"name": "Large world", "description": "A world guide.", "character_book": map[string]any{"entries": entries}}})
	s := testService(t)
	p, err := s.Preview(context.Background(), Source{Kind: "file", Filename: "world.json"}, raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Candidates) != 1 || len(p.Candidates[0].Resources) != 1 || p.Candidates[0].Resources[0].Kind != "lore.collection" || p.Candidates[0].Resources[0].ItemCount < 300 {
		t.Fatalf("character conversion split the collection: %+v", p)
	}
}
