import { useLoreCategories } from '@/features/lore/use-lore-categories'
import { LoreCategoryManager } from './LoreCategoryManager'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCheck, ImagePlus, ListChecks, MoreHorizontal, Plus, Search, Sparkles, Tags, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
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
import { Separator } from '@/components/ui/separator'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  createVersion,
  deleteProjectLoreItem,
  getVersionStatus,
  type LoreItem,
  type LoreItemImageGenerateRequest,
} from '@/lib/api'
import { cn } from '@/lib/utils'
import { useImageModelConfigured } from '@/features/settings/use-image-model-configured'
import { sectionItems, type KnowledgeSection } from './knowledge-sections'
import { LoreCard, type LoreCardSize, type LoreCoverAction } from './LoreCard'
import { LoreCoverDialog } from './LoreCoverDialog'
import { LoreMaterialGenerateDialog } from './LoreMaterialGenerateDialog'
import { notifyLoreUpdated } from './events'
import type { LoreBatchImageMode } from './lore-image-task'
import { LoreFiltersButton, LoreFilterSummary } from './LoreFilters'
import type { LoreFilters } from './lore-filters'

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
  filteredItems,
  filters,
  onFiltersChange,
  query,
  onQueryChange,
  onSelect,
  onCreate,
  onChanged,
  onReload,
  onGenerate,
  onOrganizeTypes,
  organizingDisabled,
}: {
  projectId: string
  items: LoreItem[]
  filteredItems: LoreItem[]
  filters: LoreFilters
  onFiltersChange: (filters: LoreFilters) => void
  query: string
  onQueryChange: (query: string) => void
  onSelect: (id: string) => void
  onCreate: (section: KnowledgeSection) => void
  onChanged: (item: LoreItem) => void
  onReload: () => Promise<void>
  onOrganizeTypes: () => void
  organizingDisabled: boolean
  onGenerate: (
    ids: string[],
    request: LoreItemImageGenerateRequest,
    mode: LoreBatchImageMode,
  ) => Promise<boolean>
}) {
  const { t } = useTranslation()
  const pendingCreation = useRef<KnowledgeSection | null>(null)
  const { sections: categorySections } = useLoreCategories(projectId)
  const imageConfigured = useImageModelConfigured(projectId)
  // Density is a browser preference shared by writing and game libraries.
  const [cardSize, setCardSize] = useState(readCardSize)
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
    () => filteredItems.filter((item) => selectedIds.includes(item.id)),
    [filteredItems, selectedIds],
  )
  const sections = useMemo(
    () =>
      categorySections.map((section) => ({
        ...section,
        items: sectionItems(filteredItems, section),
      })),
    [filteredItems, categorySections],
  )
  const visible = sections.flatMap((section) => section.items)
  const coverItem = items.find((item) => item.id === coverTarget?.id)
  const toggle = (id: string) =>
    setSelectedIds((ids) => (ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id]))
  useEffect(() => {
    setSelectedIds([])
  }, [filters, query])

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
          </div>
          <div className="flex flex-wrap gap-2">
            <LoreCategoryManager projectId={projectId} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm">
                  <Plus data-icon="inline-start" />
                  {t('lore.library.create')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" onCloseAutoFocus={(event) => {
                // Mount the title only after the menu releases its focus trap.
                const section = pendingCreation.current
                pendingCreation.current = null
                if (section) {
                  event.preventDefault()
                  onCreate(section)
                }
              }}>
                <DropdownMenuGroup>
                  {categorySections.map((section) => (
                    <DropdownMenuItem key={section.id} onSelect={() => { pendingCreation.current = section }}>
                      <section.icon />
                      {(section.name || t(section.labelKey))}
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
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label={t('lore.library.more')} title={t('lore.library.more')}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  <DropdownMenuItem disabled={organizingDisabled || !items.length} onSelect={onOrganizeTypes}>
                    <Tags />{t('settingPanel.loreClassification.open')}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
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
          <LoreFiltersButton projectId={projectId} items={items} filters={filters} onChange={onFiltersChange} />
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
        <LoreFilterSummary projectId={projectId} filters={filters} onChange={onFiltersChange} query={query} onQueryChange={onQueryChange} matched={visible.length} total={items.length} />
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
              aria-label={(section.name || t(section.labelKey))}
              className="flex min-w-0 flex-col gap-4"
            >
              <div className="flex items-center gap-2">
                <section.icon className="size-4 shrink-0 text-muted-foreground" />
                <h2 className="min-w-0 break-all text-sm font-medium">{(section.name || t(section.labelKey))}</h2>
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
                    onChanged={onChanged}
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
