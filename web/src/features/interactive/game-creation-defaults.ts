import type { LoreItem } from '@/lib/api'
import type { StoryDirectorModuleRefs, StoryPresentationSettings } from './types'

// Project-owned resource choices used only when initializing a new Story.
// Empty IDs/lists disable modules; absent fields retain the existing defaults.
export interface GameCreationDefaults {
  narrative_style_id?: string
  image_preset_id?: string
  planning_template_id?: string
  actor_state_id?: string
  rule_system_id?: string
  event_package_ids?: string[]
  default_background?: { mode: 'none' | 'image'; item_id?: string; asset_id?: string }
}
export const gameDefaultFields = ['default_background', 'narrative_style_id', 'actor_state_id', 'rule_system_id', 'event_package_ids', 'image_preset_id', 'planning_template_id'] as const
export type GameDefaultField = typeof gameDefaultFields[number]

export function withGameDefaultModules(refs: StoryDirectorModuleRefs, defaults: GameCreationDefaults): StoryDirectorModuleRefs {
  const next = { ...refs }
  for (const [id, disabled] of [
    ['narrative_style_id', 'narrative_style_disabled'], ['actor_state_id', 'actor_state_disabled'],
    ['rule_system_id', 'rule_system_disabled'], ['image_preset_id', 'image_preset_disabled'],
  ] as const) {
    if (defaults[id] !== undefined) { next[id] = defaults[id]; next[disabled] = defaults[id] === '' }
  }
  if (defaults.event_package_ids !== undefined) {
    next.event_package_ids = [...defaults.event_package_ids]
    next.event_packages_disabled = defaults.event_package_ids.length === 0
  }
  return next
}

export function gameDefaultPresentation(defaults: GameCreationDefaults, items: LoreItem[], unavailable: string): StoryPresentationSettings {
  const bg = defaults.default_background
  const item = items.find(item => item.id === bg?.item_id && item.enabled)
  const asset = item?.resolved_materials?.find(asset => asset.id === bg?.asset_id)
  return {
    background: true, characters: true,
    ...(bg?.mode === 'image' ? { default_background: {
      item_id: bg.item_id!, asset_id: bg.asset_id!, path: asset?.path || '', name: asset?.name || unavailable,
    } } : {}),
  }
}

export function selectedGameDefaults(defaults: GameCreationDefaults, fields: GameDefaultField[]): GameCreationDefaults {
  return Object.fromEntries(fields.filter(field => defaults[field] !== undefined).map(field => [field, defaults[field]]))
}
