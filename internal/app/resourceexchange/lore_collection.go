package resourceexchange

import (
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"denova/internal/book/lore"
	"denova/internal/revisionfile"
	"github.com/google/uuid"
)

func readLoreCollection(raw []byte) (portableCollection[json.RawMessage], []lore.Item, error) {
	var collection portableCollection[json.RawMessage]
	if err := decode(raw, &collection); err != nil {
		return collection, nil, err
	}
	if collection.Version != 1 || len(collection.Items) == 0 {
		return collection, nil, fmt.Errorf("Lore collection requires version 1 and nonempty items")
	}
	ops := make([]lore.Operation, 0, len(collection.Items))
	for _, raw := range collection.Items {
		if err := validatePayload("lore.entry", raw); err != nil {
			return collection, nil, err
		}
		var item lore.ItemInput
		if err := json.Unmarshal(raw, &item); err != nil {
			return collection, nil, err
		}
		if item.ID == "" || item.ID != strings.TrimSpace(item.ID) {
			return collection, nil, fmt.Errorf("invalid Lore item ID %q", item.ID)
		}
		ops = append(ops, lore.Operation{Op: "create", Item: item})
	}
	dir, err := os.MkdirTemp("", "denova-lore-validate-")
	if err != nil {
		return collection, nil, err
	}
	defer os.RemoveAll(dir)
	result, err := lore.NewStore(dir).ApplyOperations("Import Lore collection", ops)
	if err != nil {
		return collection, nil, err
	}
	for i, item := range result.Created {
		if item.ID != ops[i].Item.ID {
			return collection, nil, fmt.Errorf("Lore item ID must be canonical: %q", ops[i].Item.ID)
		}
	}
	return collection, result.Created, nil
}

func loreDigest(item lore.Item) string {
	// Timestamps are bookkeeping, not user edits. Resolved materials include the
	// asset identity and per-item association text, so both participate in checks.
	item.CreatedAt, item.UpdatedAt = "", ""
	raw, _ := json.Marshal(item)
	return revisionfile.Revision(raw)
}

func loreMembersState(items []lore.Item, binding Binding) string {
	digests := map[string]string{}
	for _, item := range items {
		digests[item.ID] = loreDigest(item)
	}
	return collectionMembersState(digests, binding)
}

func (s *Service) exportLoreCollection(ctx context.Context, ref LocalRef) (map[string][]byte, error) {
	_, layout, err := s.registry.Resolve(ref.ProjectID, true)
	if err != nil {
		return nil, err
	}
	items, err := lore.NewStore(layout.ContentRoot).ListAll()
	if err != nil {
		return nil, err
	}
	sourceIDs, err := s.collectionSourceIDs(ctx, ref)
	if err != nil {
		return nil, err
	}
	collection := portableCollection[json.RawMessage]{Version: 1, Items: []json.RawMessage{}}
	files := map[string][]byte{}
	for _, item := range items {
		sourceID := item.ID
		if ref.ID != "all" {
			var found bool
			sourceID, found = sourceIDs[item.ID]
			if !found {
				continue
			}
		}
		item.ID = sourceID
		raw, err := portableJSON("lore.entry", item)
		if err != nil {
			return nil, err
		}
		payload, err := s.exportLoreMaterials(ctx, ref, item, raw)
		if err != nil {
			return nil, err
		}
		collection.Items = append(collection.Items, payload["resource.json"])
		delete(payload, "resource.json")
		maps.Copy(files, payload)
	}
	if len(collection.Items) == 0 {
		return nil, fmt.Errorf("Lore collection is empty")
	}
	raw, err := json.MarshalIndent(collection, "", "  ")
	if err != nil {
		return nil, err
	}
	files["resource.json"] = raw
	return files, nil
}

func (s *Service) stageLoreCollection(ctx context.Context, previewDir string, resource PreviewResource, binding *Binding, raw []byte, replaceModified bool, staged map[FileTarget][]byte, extra *[]FileTarget, importedAssets map[FileTarget]lore.Asset) error {
	portable, incoming, err := readLoreCollection(raw)
	if err != nil {
		return err
	}
	target := FileTarget{ProjectID: binding.Local.ProjectID, Path: lore.ItemsRelativePath}
	dir, err := os.MkdirTemp("", "denova-lore-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	if len(staged[target]) > 0 {
		if err := writeFiles(dir, map[string][]byte{target.Path: staged[target]}); err != nil {
			return err
		}
	}
	store := lore.NewStore(dir)
	current, err := store.ListAll()
	if err != nil {
		return err
	}
	// Check exactly the snapshot that will be merged and guarded by the commit
	// revision. A separate live read here could miss an intervening user edit.
	if !replaceModified && loreMembersState(current, *binding) != "unchanged" {
		return ErrLocalModified
	}
	var collection lore.Collection
	if len(staged[target]) > 0 {
		if err := json.Unmarshal(staged[target], &collection); err != nil {
			return err
		}
	} else {
		collection.Version = 2
	}
	if binding.Members == nil {
		binding.Members = map[string]CollectionMember{}
	}
	// Merge by receipt identity, never by name. Missing upstream items remain local.
	for i := range incoming {
		sourceID := incoming[i].ID
		member, found := binding.Members[sourceID]
		if !found {
			member.ID = uuid.NewString()
		}
		incoming[i].ID = member.ID
		at := slices.IndexFunc(collection.Items, func(item lore.Item) bool { return item.ID == member.ID })
		if at >= 0 {
			previous := collection.Items[at]
			incoming[i].CreatedAt = previous.CreatedAt
			incoming[i].Materials, incoming[i].Image = previous.Materials, previous.Image
			collection.Items[at] = incoming[i]
		} else {
			collection.Items = append(collection.Items, incoming[i])
		}
		binding.Members[sourceID] = member
	}
	content, err := json.Marshal(collection)
	if err != nil {
		return err
	}
	if err := writeFiles(dir, map[string][]byte{target.Path: content}); err != nil {
		return err
	}
	// Reuse the native collection validator for collisions with existing items.
	if _, err := store.ListAll(); err != nil {
		return err
	}
	for i, item := range incoming {
		var payload struct {
			Materials *portableMaterials `json:"materials"`
		}
		if err := json.Unmarshal(portable.Items[i], &payload); err != nil {
			return err
		}
		if item.Materials == nil && item.Image == nil && (payload.Materials == nil || payload.Materials.Entries != nil && len(payload.Materials.Entries) == 0 && payload.Materials.CoverPath == "" && payload.Materials.CoverURL == "") {
			continue
		}
		local := binding.Local
		local.ID = item.ID
		if err := importLoreMaterials(ctx, dir, previewDir, resource, local, portable.Items[i], staged, extra, importedAssets); err != nil {
			return err
		}
	}
	items, err := store.ListAll()
	if err != nil {
		return err
	}
	byID := map[string]lore.Item{}
	for _, item := range items {
		byID[item.ID] = item
	}
	for i, raw := range portable.Items {
		var identity struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal(raw, &identity)
		binding.Members[identity.ID] = CollectionMember{ID: incoming[i].ID, Digest: loreDigest(byID[incoming[i].ID])}
	}
	staged[target], err = os.ReadFile(filepath.Join(dir, filepath.FromSlash(target.Path)))
	return err
}
