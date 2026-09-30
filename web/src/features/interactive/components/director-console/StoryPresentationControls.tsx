import { useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Images } from 'lucide-react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { StageCharacterLayout } from '@/features/settings/types'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { Field, FieldDescription, FieldTitle } from '@/components/ui/field'
import { patchProjectSettings, patchSettings } from '@/features/settings/api'
import { toast } from '@/lib/toast'
import { visibleStoryPresentation } from '../../presentation'
import { StoryBackgroundSelect } from './StoryBackgroundSelect'
import type { PresentationMaterial, TurnEvent, StoryPresentationSettings } from '../../types'
import { useStagePreferences } from '../story-stage/use-stage-preferences'
import { ControlSection, NumberSettingInput, TuningRow } from './StoryTuningControls'

interface StoryPresentationControlsProps {
  projectId?: string
  value?: StoryPresentationSettings
  disabled: boolean
  onChange: (settings: StoryPresentationSettings) => void
  currentTurn?: TurnEvent
  onBackgroundChange?: (turnId: string, background?: PresentationMaterial) => Promise<void>
  backgroundDisabled?: boolean
}

export function StoryPresentationControls({ projectId, value, disabled, onChange, currentTurn, onBackgroundChange, backgroundDisabled = false }: StoryPresentationControlsProps) {
  const { t } = useTranslation()
  const { scrimOpacity, textMaxWidth, characterLayout } = useStagePreferences(projectId || '')
  const [savingLayout, setSavingLayout] = useState(false)
  const saveLayout = async (layout: StageCharacterLayout) => {
    setSavingLayout(true)
    try {
      const changes = { interactive_stage_character_layout: layout }
      if (projectId) await patchProjectSettings(projectId, 'user', changes)
      else await patchSettings('user', changes)
      console.info('[story-presentation] user character layout saved', { layout })
    } catch (error) {
      console.warn('[story-presentation] failed to save user character layout', { error })
      toast.error(t('storyStage.presentation.saveFailed'))
    } finally {
      setSavingLayout(false)
    }
  }
  const [widthDraft, setWidthDraft] = useState<number>()
  const [savingWidth, setSavingWidth] = useState(false)
  const [draft, setDraft] = useState<number>()
  const latestEdit = useRef({ value: scrimOpacity, version: 0 })
  const saveQueue = useRef(Promise.resolve())
  const labelId = useId()
  const descriptionId = useId()
  const [savingBackground, setSavingBackground] = useState(false)
  const changeCurrentBackground = async (background?: PresentationMaterial) => {
    if (!currentTurn || !onBackgroundChange) return
    setSavingBackground(true)
    try {
      await onBackgroundChange(currentTurn.id, background)
    } catch (error) {
      console.warn('[story-presentation] failed to change current background', error)
      toast.error(t('storyStage.presentation.backgroundUpdateFailed'))
    } finally {
      setSavingBackground(false)
    }
  }
  const settings = { background: true, characters: true, ...value }
  const opacity = draft ?? scrimOpacity
  const saveTextMaxWidth = async (value: number) => {
    setWidthDraft(value)
    setSavingWidth(true)
    try {
      const changes = { interactive_stage_text_max_width: value }
      const saved = projectId
        ? await patchProjectSettings(projectId, 'user', changes)
        : await patchSettings('user', changes)
      setWidthDraft(projectId ? undefined : saved.effective.interactive_stage_text_max_width ?? value)
    } catch (error) {
      console.warn('[story-presentation] failed to save text maximum width', error)
      toast.error(t('storyStage.presentation.saveFailed'))
      setWidthDraft(undefined)
    } finally {
      setSavingWidth(false)
    }
  }
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
      <StoryBackgroundSelect
        projectId={projectId}
        value={visibleStoryPresentation(currentTurn?.turn_result?.presentation, settings).background}
        disabled={disabled || savingBackground || (!!currentTurn && (backgroundDisabled || !onBackgroundChange))}
        onChange={background => {
          if (currentTurn) void changeCurrentBackground(background)
          else onChange({ ...settings, default_background: background })
        }}
      />
      <TuningRow title={t('storyStage.presentation.background')} description={t('storyStage.presentation.backgroundHelp')}>
        <Switch aria-label={t('storyStage.presentation.background')} checked={settings.background} disabled={disabled} onCheckedChange={background => onChange({ ...settings, background })} />
      </TuningRow>
      <TuningRow title={t('storyStage.presentation.characters')} description={t('storyStage.presentation.charactersHelp')}>
        <Switch aria-label={t('storyStage.presentation.characters')} checked={settings.characters} disabled={disabled} onCheckedChange={characters => onChange({ ...settings, characters })} />
      </TuningRow>
      <Field className="director-control-row min-w-0 gap-2 px-2.5 py-2">
        <FieldTitle>{t('storyStage.presentation.characterLayout')}</FieldTitle>
        <ToggleGroup type="single" variant="outline" size="sm" className="w-full flex-wrap" disabled={savingLayout}
          aria-label={t('storyStage.presentation.characterLayout')}
          value={characterLayout}
          onValueChange={value => { if (value) void saveLayout(value as StageCharacterLayout) }}>
          {(['center', 'left', 'right', 'sides'] as const).map(layout => (
            <ToggleGroupItem key={layout} value={layout}>{t(`storyStage.presentation.layout.${layout}`)}</ToggleGroupItem>
          ))}
        </ToggleGroup>
        <FieldDescription>{t('storyStage.presentation.layoutHelp')}</FieldDescription>
      </Field>
      <TuningRow title={t('storyStage.presentation.textMaxWidth')} description={t('storyStage.presentation.textMaxWidthHelp')}>
        <NumberSettingInput label={t('storyStage.presentation.textMaxWidth')} value={widthDraft ?? textMaxWidth} min={480} max={1600} disabled={savingWidth} onCommit={value => void saveTextMaxWidth(value)} />
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
