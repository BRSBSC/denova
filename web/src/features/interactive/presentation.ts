import type { StoryPresentationSettings, TurnPresentation } from './types'

// A committed presentation can explicitly clear its background. Only an absent
// snapshot uses the opening default; turning dynamics off always uses the default.
export function visibleStoryPresentation(stage?: TurnPresentation, settings?: StoryPresentationSettings): TurnPresentation {
  return {
    background: settings?.background !== false && stage ? stage.background : settings?.default_background,
    characters: settings?.characters !== false ? stage?.characters : undefined,
  }
}
