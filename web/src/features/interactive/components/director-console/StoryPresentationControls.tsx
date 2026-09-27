import { useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Images } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { Field, FieldDescription, FieldTitle } from '@/components/ui/field'
import { patchProjectSettings, patchSettings } from '@/features/settings/api'
import { toast } from '@/lib/toast'
import type { LoreItem } from '@/lib/api'
import { StoryBackgroundSelect } from './StoryBackgroundSelect'
import type { StoryPresentationSettings } from '../../types'
import { useStagePreferences } from '../story-stage/use-stage-preferences'
import { ControlSection, TuningRow } from './StoryTuningControls'

export function StoryPresentationControls({ projectId, value, loreItems, disabled, onChange }: { projectId?: string; value?: StoryPresentationSettings; loreItems?: LoreItem[]; disabled: boolean; onChange: (settings: StoryPresentationSettings) => void }) {
  const { t } = useTranslation()
  const { scrimOpacity } = useStagePreferences(projectId || '')
  const [draft, setDraft] = useState<number>()
  const latestEdit = useRef({ value: scrimOpacity, version: 0 })
  const saveQueue = useRef(Promise.resolve())
  const labelId = useId()
  const descriptionId = useId()
  const settings = { background: true, characters: true, ...value }
  const opacity = draft ?? scrimOpacity
  const changeOpacity = (value: number) => {
    // Keyboard input may report the commit before the matching value change.
    if (latestEdit.current.value !== value) {
      latestEdit.current = { value, version: latestEdit.current.version + 1 }
    }
    setDraft(value)
  }
  const saveOpacity = (value: number) => {
    changeOpacity(value)
    const version = latestEdit.current.version
    // Serialize committed values without blocking input or dropping them on unmount.
    saveQueue.current = saveQueue.current.then(async () => {
      try {
        const changes = { interactive_stage_scrim_opacity: value }
        // Prime the same snapshot that useStagePreferences observes before releasing the draft.
        const saved = projectId
          ? await patchProjectSettings(projectId, 'user', changes)
          : await patchSettings('user', changes)
        if (version === latestEdit.current.version) {
          setDraft(projectId ? undefined : saved.effective.interactive_stage_scrim_opacity ?? value)
        }
      } catch (error) {
        console.warn('[story-presentation] failed to save reading scrim opacity', error)
        toast.error(t('storyStage.presentation.saveFailed'))
        if (version === latestEdit.current.version) setDraft(undefined)
      }
    })
  }
  return (
    <ControlSection icon={<Images className="size-4" />} title={t('storyStage.presentation.title')}>
      <StoryBackgroundSelect projectId={projectId} value={settings.default_background} loreItems={loreItems} disabled={disabled} onChange={default_background => onChange({ ...settings, default_background })} />
      <TuningRow title={t('storyStage.presentation.background')} description={t('storyStage.presentation.backgroundHelp')}>
        <Switch aria-label={t('storyStage.presentation.background')} checked={settings.background} disabled={disabled} onCheckedChange={background => onChange({ ...settings, background })} />
      </TuningRow>
      <TuningRow title={t('storyStage.presentation.characters')} description={t('storyStage.presentation.charactersHelp')}>
        <Switch aria-label={t('storyStage.presentation.characters')} checked={settings.characters} disabled={disabled} onCheckedChange={characters => onChange({ ...settings, characters })} />
      </TuningRow>
      <Field className="director-control-row min-w-0 gap-2 px-2.5 py-2">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <FieldTitle id={labelId} className="min-w-0 text-xs">{t('storyStage.presentation.scrim')}</FieldTitle>
          <span className="w-9 shrink-0 text-right text-xs tabular-nums" aria-hidden="true">{Math.round(opacity * 100)}%</span>
        </div>
        <Slider aria-labelledby={labelId} aria-describedby={descriptionId} aria-valuetext={`${Math.round(opacity * 100)}%`} min={0} max={1} step={0.01} value={[opacity]} className="min-h-5" onValueChange={([value]) => changeOpacity(value)} onValueCommit={([value]) => saveOpacity(value)} />
        <FieldDescription id={descriptionId} className="text-[10px] leading-4 text-wrap!">{t('storyStage.presentation.scrimHelp')}</FieldDescription>
      </Field>
    </ControlSection>
  )
}
