import { useState } from 'react'
import { ImagePlus, Images, Sparkles, Upload } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import { loreImageURL, updateProjectLoreItem, type LoreItem } from '@/lib/api'
import { cn } from '@/lib/utils'
import { MaterialImage } from './MaterialImage'
import { hasLoreProtagonistTag } from './tags'
import { notifyLoreUpdated } from './events'

export type LoreCoverAction = 'upload' | 'generate' | 'choose'
export type LoreCardSize = 'small' | 'medium' | 'large'

export function LoreCard({
  projectId,
  item,
  cardSize,
  selecting,
  selected,
  imageConfigured,
  onSelect,
  onToggle,
  onCover,
  onChanged,
}: {
  projectId: string
  item: LoreItem
  cardSize: LoreCardSize
  selecting: boolean
  selected: boolean
  imageConfigured: boolean
  onSelect: () => void
  onToggle: () => void
  onCover: (action: LoreCoverAction) => void
  onChanged: (item: LoreItem) => void
}) {
  const { t } = useTranslation()
  const [savingEnabled, setSavingEnabled] = useState(false)
  const image = loreImageURL(projectId, item)
  const generationDisabled = !imageConfigured || !item.enabled
  const generationHint = !imageConfigured
    ? t('lore.library.configureImage')
    : !item.enabled
      ? t('lore.library.enableToGenerate')
      : undefined
  const generationLabel = t(image ? 'lore.library.regenerate' : 'lore.library.generateCover')
  const protagonist = item.type === 'character' && hasLoreProtagonistTag(item.tags)
  const materialCount = item.resolved_materials?.length ?? 0
  const setEnabled = async (enabled: boolean) => {
    setSavingEnabled(true)
    try {
      const saved = await updateProjectLoreItem(projectId, item.id, { ...item, enabled }, item.updated_at)
      onChanged(saved)
      notifyLoreUpdated({ projectId, source: 'library' })
    } catch (error) {
      console.error('[lore-card] enabled state update failed', { projectId, itemId: item.id, error })
      toast.error(t('lore.library.toggleFailed'))
    } finally {
      setSavingEnabled(false)
    }
  }
  return (
    <Card
      size="sm"
      data-testid={`lore-card-${item.id}`}
      className={cn(
        'min-w-0 cursor-pointer pt-0 transition-shadow focus-within:ring-ring',
        cardSize === 'small' && 'data-[size=sm]:[--card-spacing:--spacing(2)]',
        selected ? 'ring-2 ring-primary' : 'hover:ring-foreground/25',
      )}
      onClick={selecting ? onToggle : onSelect}
    >
      <div className="flex aspect-[16/10] shrink-0 items-center justify-center overflow-hidden bg-muted">
        {image ? (
          <MaterialImage
            key={image}
            src={image}
            alt={item.name}
            className="size-full object-contain"
          />
        ) : (
          <div className="flex flex-col items-center gap-2 text-muted-foreground">
            <ImagePlus className="size-7" />
            <span className="text-xs">{t('lore.library.noCover')}</span>
          </div>
        )}
      </div>
      <CardHeader className="min-w-0 items-center gap-x-2">
        <CardTitle className="min-w-0">
          <button
            type="button"
            className={cn(
              'w-full text-left outline-none',
              cardSize === 'small' ? 'truncate' : 'line-clamp-2 break-words',
            )}
            title={item.name}
            onClick={(event) => {
              event.stopPropagation()
              selecting ? onToggle() : onSelect()
            }}
          >
            {item.name}
          </button>
        </CardTitle>
        <CardAction
          className="flex size-8 row-span-1 items-center justify-center self-center"
          onClick={(event) => event.stopPropagation()}
        >
          {selecting ? (
            <Checkbox
              className="relative after:absolute after:-inset-2"
              checked={selected}
              onCheckedChange={onToggle}
              aria-label={t('lore.library.selectItem', { name: item.name })}
            />
          ) : (
            <Switch
              checked={item.enabled}
              disabled={savingEnabled}
              onCheckedChange={(enabled) => void setEnabled(enabled)}
              aria-label={t('lore.library.enabledFor', { name: item.name })}
              title={t(item.enabled ? 'settingPanel.enabled' : 'settingPanel.disabled')}
            />
          )}
        </CardAction>
        {cardSize !== 'small' && (
          <CardDescription
            className={cn(
              'col-span-full break-words',
              cardSize === 'large' ? 'line-clamp-3 min-h-15' : 'line-clamp-2 min-h-10',
            )}
          >
            {item.brief_description || t('lore.library.noDescription')}
          </CardDescription>
        )}
      </CardHeader>
      {(!selecting || protagonist || !item.enabled || materialCount > 0) && (
        <CardContent className="mt-auto flex flex-wrap items-center gap-1">
          {protagonist && <Badge variant="outline">{t('lore.library.protagonist')}</Badge>}
          {selecting && !item.enabled && <Badge variant="outline">{t('lore.library.disabled')}</Badge>}
          {selecting ? (
            materialCount > 0 && (
              <Badge variant="outline">
                {t('lore.materials.tab', { count: materialCount })}
              </Badge>
            )
          ) : (
            <div
              className="flex min-w-max flex-1 items-center gap-0.5"
              onClick={(event) => event.stopPropagation()}
            >
              <Button
                size="sm"
                variant="ghost"
                className="px-1.5"
                onClick={() => onCover('choose')}
                aria-label={t('lore.library.chooseCoverFor', { name: item.name })}
                title={`${t('lore.library.chooseCover')} · ${t('lore.materials.tab', { count: materialCount })}`}
              >
                <Images />
                <span>{materialCount}</span>
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                className="ml-auto"
                aria-label={t('lore.library.uploadCover')}
                title={t('lore.library.uploadCover')}
                onClick={() => onCover('upload')}
              >
                <Upload />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={generationDisabled}
                aria-label={generationLabel}
                title={generationHint || generationLabel}
                onClick={() => onCover('generate')}
              >
                <Sparkles />
              </Button>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  )
}
