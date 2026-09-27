import { ImagePlus, Images, MoreHorizontal, Sparkles, Upload } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { loreImageURL, type LoreItem } from '@/lib/api'
import { cn } from '@/lib/utils'
import { MaterialImage } from './MaterialImage'
import { hasLoreProtagonistTag } from './tags'

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
}) {
  const { t } = useTranslation()
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
          ) : cardSize === 'large' ? (
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => onCover('choose')}
              aria-label={t('lore.library.chooseCoverFor', { name: item.name })}
            >
              <Images />
            </Button>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t('lore.library.coverActionsFor', { name: item.name })}
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  <DropdownMenuItem onSelect={() => onCover('choose')}>
                    <Images />
                    {t('lore.library.chooseCover')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onCover('upload')}>
                    <Upload />
                    {t('lore.library.uploadCover')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={generationDisabled}
                    title={generationHint}
                    onSelect={() => onCover('generate')}
                  >
                    <Sparkles />
                    {generationLabel}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
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
      {(protagonist || !item.enabled || materialCount > 0) && (
        <CardContent className="mt-auto flex flex-wrap items-start gap-1.5">
          {protagonist && <Badge variant="outline">{t('lore.library.protagonist')}</Badge>}
          {!item.enabled && <Badge variant="outline">{t('lore.library.disabled')}</Badge>}
          {materialCount > 0 && (
            <Badge variant="outline">
              {t('lore.materials.tab', { count: materialCount })}
            </Badge>
          )}
        </CardContent>
      )}
      {!selecting && cardSize === 'large' && (
        <CardFooter
          className="mt-auto flex-wrap justify-between gap-1"
          onClick={(event) => event.stopPropagation()}
        >
          <Button size="sm" variant="ghost" onClick={() => onCover('upload')}>
            <Upload data-icon="inline-start" />
            {t('lore.library.uploadCover')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={generationDisabled}
            title={generationHint}
            onClick={() => onCover('generate')}
          >
            <Sparkles data-icon="inline-start" />
            {generationLabel}
          </Button>
        </CardFooter>
      )}
    </Card>
  )
}
