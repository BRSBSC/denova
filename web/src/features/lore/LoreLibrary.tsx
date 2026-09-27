import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCheck, ImagePlus, ListChecks, Plus, Search, Sparkles, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldLabel } from '@/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  createVersion,
  deleteProjectLoreItem,
  getVersionStatus,
  loreImageURL,
  type LoreItem,
  type LoreItemImageGenerateRequest,
} from '@/lib/api'
import { cn } from '@/lib/utils'
import { useImageModelConfigured } from '@/features/settings/use-image-model-configured'
import { KNOWLEDGE_SECTIONS, sectionItems, type KnowledgeSection } from './knowledge-sections'
import { LoreCard, type LoreCardSize, type LoreCoverAction } from './LoreCard'
import { LoreCoverDialog } from './LoreCoverDialog'
import { LoreMaterialGenerateDialog } from './LoreMaterialGenerateDialog'
import { notifyLoreUpdated } from './events'
import type { LoreBatchImageMode } from './lore-image-task'

export const LORE_OVERVIEW_ID = '__lore_overview__'

const CARD_SIZE_KEY = 'nova.lore.card-size'
const CARD_SIZES = ['small', 'medium', 'large'] as const
const CARD_LAYOUTS: Record<LoreCardSize, string> = {
  small: 'grid-cols-[repeat(auto-fill,minmax(min(100%,160px),1fr))] gap-2',
  medium: 'grid-cols-[repeat(auto-fill,minmax(min(100%,200px),1fr))] gap-3',
  large: 'grid-cols-[repeat(auto-fill,minmax(min(100%,250px),1fr))] gap-4',
}

function readCardSize(): LoreCardSize {
  try {
    const value = window.localStorage.getItem(CARD_SIZE_KEY)
    if (value === 'small' || value === 'medium' || value === 'large') return value
  } catch {
    // Browsing remains available when storage is blocked by the host webview.
  }
  return 'medium'
}

/** Browsing state stays mounted while the existing editor handles a selected item. */
export function LoreLibrary({
  projectId,
  items,
  query,
  onQueryChange,
  onSelect,
  onCreate,
  onChanged,
  onReload,
  onGenerate,
}: {
  projectId: string
  items: LoreItem[]
  query: string
  onQueryChange: (query: string) => void
  onSelect: (id: string) => void
  onCreate: (section: KnowledgeSection) => void
  onChanged: (item: LoreItem) => void
  onReload: () => Promise<void>
  onGenerate: (
    ids: string[],
    request: LoreItemImageGenerateRequest,
    mode: LoreBatchImageMode,
  ) => Promise<boolean>
}) {
  const { t } = useTranslation()
  const imageConfigured = useImageModelConfigured(projectId)
  // Density is a browser preference shared by writing and game libraries.
  const [cardSize, setCardSize] = useState(readCardSize)
  const [category, setCategory] = useState('all')
  const [cover, setCover] = useState('all')
  const [selecting, setSelecting] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [coverTarget, setCoverTarget] = useState<{ id: string; action: LoreCoverAction } | null>(
    null,
  )
  const [deleteTargets, setDeleteTargets] = useState<LoreItem[] | null>(null)
  const [generationTargets, setGenerationTargets] = useState<string[] | null>(null)
  const [generationMode, setGenerationMode] = useState<LoreBatchImageMode>('missing_covers')
  const [busy, setBusy] = useState(false)
  const selected = useMemo(
    () => items.filter((item) => selectedIds.includes(item.id)),
    [items, selectedIds],
  )
  const sections = useMemo(
    () =>
      KNOWLEDGE_SECTIONS.filter((section) => category === 'all' || section.id === category).map(
        (section) => ({
          ...section,
          items: sectionItems(items, section, query).filter(
            (item) =>
              cover === 'all' || Boolean(loreImageURL(projectId, item)) === (cover === 'with'),
          ),
        }),
      ),
    [category, cover, items, projectId, query],
  )
  const visible = sections.flatMap((section) => section.items)
  const coverItem = items.find((item) => item.id === coverTarget?.id)
  const toggle = (id: string) =>
    setSelectedIds((ids) => (ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id]))
  useEffect(() => {
    setSelectedIds([])
  }, [category, cover, query])

  const deleteSelected = async () => {
    if (!deleteTargets) return
    setBusy(true)
    try {
      // Reuse version recovery. If a recovery point cannot be created, delete nothing.
      const status = await getVersionStatus(projectId)
      if (!status.clean || !status.latest) {
        const snapshot = await createVersion(projectId, t('lore.library.deleteSnapshot'))
        if (!snapshot.version) throw new Error(t('lore.library.snapshotFailed'))
      }
      const failed: LoreItem[] = []
      for (const item of deleteTargets) {
        try {
          await deleteProjectLoreItem(projectId, item.id)
        } catch (error) {
          failed.push(item)
          console.error('[lore-library] deletion failed', { projectId, itemId: item.id, error })
        }
      }
      setSelectedIds(failed.map((item) => item.id))
      notifyLoreUpdated({ projectId, ids: [], source: 'materials' })
      const message = t('lore.library.deleteResult', {
        success: deleteTargets.length - failed.length,
        failed: failed.length,
      })
      if (failed.length) toast.error(message)
      else toast.success(message)
      setDeleteTargets(null)
      await onReload()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto" data-testid="lore-library">
      <div className="mx-auto flex w-full min-w-0 max-w-[1600px] flex-col gap-6 p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold tracking-tight">{t('lore.library.title')}</h1>
            <Badge variant="outline">{items.length}</Badge>
          </div>
          <div className="flex flex-wrap gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm">
                  <Plus data-icon="inline-start" />
                  {t('lore.library.create')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  {KNOWLEDGE_SECTIONS.map((section) => (
                    <DropdownMenuItem key={section.id} onSelect={() => onCreate(section)}>
                      <section.icon />
                      {t(section.labelKey)}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              size="sm"
              variant="outline"
              disabled={!items.length}
              onClick={() => {
                setSelecting(!selecting)
                setSelectedIds([])
              }}
            >
              {selecting ? <X data-icon="inline-start" /> : <ListChecks data-icon="inline-start" />}
              {t(selecting ? 'lore.library.exitSelection' : 'lore.library.batch')}
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <InputGroup className="min-w-0 flex-1 basis-64">
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder={t('lore.library.search')}
              aria-label={t('lore.library.search')}
            />
          </InputGroup>
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger aria-label={t('lore.library.category')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">{t('lore.library.allCategories')}</SelectItem>
                {KNOWLEDGE_SECTIONS.map((section) => (
                  <SelectItem key={section.id} value={section.id}>
                    {t(section.labelKey)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <ToggleGroup
            type="single"
            value={cover}
            onValueChange={(value) => value && setCover(value)}
            variant="outline"
            size="sm"
            spacing={0}
            aria-label={t('lore.library.coverFilter')}
          >
            {['all', 'with', 'without'].map((value) => (
              <ToggleGroupItem value={value} key={value}>
                {t(`lore.library.cover.${value}`)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <ToggleGroup
            type="single"
            value={cardSize}
            onValueChange={(value) => {
              if (!value) return
              setCardSize(value as LoreCardSize)
              try {
                window.localStorage.setItem(CARD_SIZE_KEY, value)
              } catch {
                // Keep the selected density usable without persistent storage.
              }
            }}
            variant="outline"
            size="sm"
            spacing={0}
            className="ml-auto"
            aria-label={t('lore.library.cardSize')}
          >
            {CARD_SIZES.map((size) => (
              <ToggleGroupItem value={size} key={size}>
                {t(`lore.library.cardSize.${size}`)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        {selecting && (
          <div
            className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border bg-background p-3"
            role="toolbar"
            aria-label={t('lore.library.batch')}
          >
            <span className="mr-auto text-sm" role="status">
              {t('lore.library.selected', { count: selected.length })}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !visible.length}
              onClick={() => setSelectedIds(visible.map((item) => item.id))}
            >
              <CheckCheck data-icon="inline-start" />
              {t('lore.library.selectVisible')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !imageConfigured || !selected.some((item) => item.enabled)}
              onClick={() =>
                setGenerationTargets(selected.filter((item) => item.enabled).map((item) => item.id))
              }
            >
              <Sparkles data-icon="inline-start" />
              {t('lore.materials.generate')}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={busy || !selected.length}
              onClick={() => setDeleteTargets(selected)}
            >
              <Trash2 data-icon="inline-start" />
              {t('common.delete')}
            </Button>
          </div>
        )}
        {sections
          .filter((section) => section.items.length)
          .map((section) => (
            <section
              key={section.id}
              aria-label={t(section.labelKey)}
              className="flex min-w-0 flex-col gap-4"
            >
              <div className="flex items-center gap-2">
                <section.icon className="size-4 text-muted-foreground" />
                <h2 className="text-sm font-medium">{t(section.labelKey)}</h2>
                <span className="text-xs text-muted-foreground">{section.items.length}</span>
                <Separator className="ml-2 flex-1" />
              </div>
              <div className={cn('grid', CARD_LAYOUTS[cardSize])}>
                {section.items.map((item) => (
                  <LoreCard
                    key={item.id}
                    projectId={projectId}
                    item={item}
                    cardSize={cardSize}
                    selecting={selecting}
                    selected={selectedIds.includes(item.id)}
                    imageConfigured={imageConfigured}
                    onSelect={() => onSelect(item.id)}
                    onToggle={() => toggle(item.id)}
                    onCover={(action) => setCoverTarget({ id: item.id, action })}
                  />
                ))}
              </div>
            </section>
          ))}
        {!visible.length && (
          <Empty className="py-16">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ImagePlus />
              </EmptyMedia>
              <EmptyTitle>
                {t(items.length ? 'lore.library.noMatches' : 'lore.library.empty')}
              </EmptyTitle>
              <EmptyDescription>
                {t(items.length ? 'lore.library.noMatchesHint' : 'lore.library.emptyHint')}
              </EmptyDescription>
            </EmptyHeader>
            {!!items.length && (
              <Button
                variant="outline"
                onClick={() => {
                  onQueryChange('')
                  setCategory('all')
                  setCover('all')
                }}
              >
                {t('lore.library.clearFilters')}
              </Button>
            )}
          </Empty>
        )}
      </div>
      {coverItem && coverTarget && (
        <LoreCoverDialog
          key={`${projectId}:${coverItem.id}:${coverTarget.action}`}
          projectId={projectId}
          item={coverItem}
          action={coverTarget.action}
          imageConfigured={imageConfigured}
          onChanged={onChanged}
          onClose={() => setCoverTarget(null)}
        />
      )}
      {generationTargets && (
        <LoreMaterialGenerateDialog
          busy={busy}
          modes={['agent']}
          title={t('lore.library.batchGenerate', { count: generationTargets.length })}
          description={t('lore.library.batchHint')}
          onClose={() => setGenerationTargets(null)}
          onGenerate={async (request) => {
            setBusy(true)
            try {
              const ok = await onGenerate(generationTargets, request, generationMode)
              if (ok) setGenerationTargets(null)
              return ok
            } finally {
              setBusy(false)
            }
          }}
        >
          <Field>
            <FieldLabel>{t('lore.library.generationScope')}</FieldLabel>
            <ToggleGroup
              type="single"
              value={generationMode}
              onValueChange={(value) => value && setGenerationMode(value as LoreBatchImageMode)}
              variant="outline"
              className="flex-wrap"
              disabled={busy}
            >
              <ToggleGroupItem value="missing_covers">
                {t('lore.library.fillMissing')}
              </ToggleGroupItem>
              <ToggleGroupItem value="additional">{t('lore.library.addImages')}</ToggleGroupItem>
            </ToggleGroup>
          </Field>
        </LoreMaterialGenerateDialog>
      )}
      <ConfirmDialog
        open={!!deleteTargets}
        onOpenChange={(open) => {
          if (!open) setDeleteTargets(null)
        }}
        title={t('lore.library.deleteTitle', { count: deleteTargets?.length ?? 0 })}
        description={t('lore.library.deleteHint')}
        details={deleteTargets?.map((item) => item.name)}
        confirmLabel={t('common.delete')}
        tone="danger"
        onConfirm={deleteSelected}
      />
    </div>
  )
}
