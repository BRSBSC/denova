package resourceexchange

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"

	"denova/internal/revisionfile"
	"github.com/google/uuid"
)

func readOpeningCollection(raw []byte) (portableCollection[opening], error) {
	var collection portableCollection[opening]
	if err := decode(raw, &collection); err != nil {
		return collection, err
	}
	if collection.Version != 1 || len(collection.Items) == 0 {
		return collection, fmt.Errorf("opening collection requires version 1 and nonempty items")
	}
	seen := map[string]bool{}
	for _, item := range collection.Items {
		// Source IDs identify JSON members, never filesystem paths.
		if strings.TrimSpace(item.ID) == "" || item.ID != strings.TrimSpace(item.ID) || seen[item.ID] || strings.TrimSpace(item.Title) == "" || strings.TrimSpace(item.Content) == "" || len(item.Content) > 64*1024 {
			return collection, fmt.Errorf("invalid or duplicate game opening %q", item.ID)
		}
		seen[item.ID] = true
	}
	return collection, nil
}

func openingDigest(item opening) string {
	raw, _ := json.Marshal(item)
	return revisionfile.Revision(raw)
}

func openingMembersState(items []opening, binding Binding) string {
	digests := map[string]string{}
	for _, item := range items {
		digests[item.ID] = openingDigest(item)
	}
	return collectionMembersState(digests, binding)
}

func stageOpeningCollection(binding *Binding, raw, current []byte, replaceModified bool) ([]byte, error) {
	incoming, err := readOpeningCollection(raw)
	if err != nil {
		return nil, err
	}
	next := openings{Version: 1, Presets: []opening{}}
	if len(current) > 0 {
		if err := json.Unmarshal(current, &next); err != nil {
			return nil, err
		}
	}
	// Compare the exact staged snapshot, which is revision-guarded on commit.
	if !replaceModified && openingMembersState(next.Presets, *binding) != "unchanged" {
		return nil, ErrLocalModified
	}
	if binding.Members == nil {
		binding.Members = map[string]CollectionMember{}
	}
	for _, item := range incoming.Items {
		sourceID := item.ID
		member, found := binding.Members[sourceID]
		if !found {
			member.ID = uuid.NewString()
		}
		item.ID = member.ID
		index := slices.IndexFunc(next.Presets, func(existing opening) bool { return existing.ID == item.ID })
		if index < 0 {
			next.Presets = append(next.Presets, item)
		} else {
			next.Presets[index] = item
		}
		binding.Members[sourceID] = CollectionMember{ID: item.ID, Digest: openingDigest(item)}
	}
	// Entries omitted upstream remain local, matching Lore collection updates.
	return json.MarshalIndent(next, "", "  ")
}

func (s *Service) exportOpeningCollection(ctx context.Context, ref LocalRef) (map[string][]byte, error) {
	snapshot, err := s.snapshot(ctx, FileTarget{ProjectID: ref.ProjectID, Path: openingPath})
	if err != nil {
		return nil, err
	}
	var native openings
	if err := json.Unmarshal(snapshot.Content, &native); err != nil {
		return nil, err
	}
	sourceIDs, err := s.collectionSourceIDs(ctx, ref)
	if err != nil {
		return nil, err
	}
	collection := portableCollection[opening]{Version: 1, Items: []opening{}}
	for _, item := range native.Presets {
		if ref.ID != "all" {
			sourceID, found := sourceIDs[item.ID]
			if !found {
				continue
			}
			item.ID = sourceID
		}
		collection.Items = append(collection.Items, item)
	}
	raw, err := json.MarshalIndent(collection, "", "  ")
	if err != nil {
		return nil, err
	}
	if _, err := readOpeningCollection(raw); err != nil {
		return nil, err
	}
	return map[string][]byte{"resource.json": raw}, nil
}
