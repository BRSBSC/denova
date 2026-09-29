import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ImportResourcePicker } from './ImportResourcePicker'
import { CompatibilityReport } from '@/components/workbench/CharacterCardImportDialog'
import { createBook, getBooks, type BookRecord } from '@/lib/api'
import {
  dependencySelection,
  discardPreview,
  exchange,
  previewSource,
  type Installation,
  type Plan,
  type Preview,
  type Source,
} from './api'

export interface ImportDialogProps {
  source?: Source
  preview?: Preview
  installation?: Installation
  projectID?: string
  initialScope?: string
  onClose: () => void
  onInstalled: (installation: Installation) => void | Promise<void>
}
export function ImportDialog({
  source,
  preview: initialPreview,
  installation,
  projectID: defaultProject,
  initialScope = 'user',
  onClose,
  onInstalled,
}: ImportDialogProps) {
  const { t } = useTranslation()
  const [preview, setPreview] = useState(initialPreview)
  const [candidateID, setCandidateID] = useState(
    initialPreview?.candidates.find(
      (candidate) =>
        !installation || candidate.package.id === installation.package.id,
    )?.candidate_id || '',
  )
  const [selected, setSelected] = useState(
    initialPreview?.candidates
      .find(
        (candidate) =>
          !installation || candidate.package.id === installation.package.id,
      )
      ?.resources.filter(
        (resource) =>
          !installation ||
          installation.bindings.some(
            (binding) => binding.resource_id === resource.id,
          ),
      )
      .map((r) => r.id) || [],
  )
  const [plan, setPlan] = useState<Plan>()
  const [sourceKind, setSourceKind] = useState('github')
  const [url, setURL] = useState(source?.url || '')
  const [ref, setRef] = useState(source?.ref || '')
  const [path, setPath] = useState(source?.path || '')
  const [file, setFile] = useState<File>()
  const [projectID, setProjectID] = useState(
    installation?.project_id || defaultProject || '',
  )
  const [bookDestination, setBookDestination] = useState<'new' | 'existing'>('existing')
  const [bookTitle, setBookTitle] = useState('')
  const [scope, setScope] = useState(initialScope)
  const [books, setBooks] = useState<BookRecord[]>([])
  const [grants, setGrants] = useState<Record<string, string[]>>({})
  const [names, setNames] = useState<Record<string, string>>({})
  const [replace, setReplace] = useState(false)
  const [busy, setBusy] = useState(!!source && !initialPreview)
  const alive = useRef(false)
  const pending = useRef<Promise<void> | undefined>(undefined)
  const downloadedPreview = useRef<Preview | undefined>(undefined)
  const [error, setError] = useState('')
  const candidate = preview?.candidates.find(
    (c) => c.candidate_id === candidateID,
  )
  const chosen = dependencySelection(candidate?.resources || [], selected)
  const resources =
    candidate?.resources.filter((r) => chosen.includes(r.id)) || []
  const needsProject =
    resources.some((r) =>
      ['lore.collection', 'game.openings', 'project.cover'].includes(r.kind),
    ) || (resources.some((r) => r.kind === 'skill') && scope === 'workspace')
  const canCreateBook = !installation && resources.some((r) => r.kind === 'lore.collection')
  const creatingBook = canCreateBook && bookDestination === 'new'
  const missingConsent = resources.some((r) =>
    r.extension?.manifest.permissions.required.some(
      (p) => !(grants[r.id] || []).includes(p),
    ),
  )
  useEffect(() => {
    let alive = true
    void getBooks()
      .then((items) => {
        if (alive) setBooks(items)
      })
      .catch(() => {
        if (alive) setError(t('market.errors.projectsUnavailable'))
      })
    return () => {
      alive = false
    }
  }, [t])
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (error) {
      console.error('[market] import operation failed', error)
      if (alive.current) setError(
        error instanceof Error
          ? error.message
          : t('market.errors.operationFailed'),
      )
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  const loadPreview = () => {
    if (pending.current) return pending.current
    pending.current = (async () => {
      const result = await previewSource(file || source || {
        kind: sourceKind as Source['kind'], url,
        ref: ref || undefined, path: path || undefined,
      })
      if (!alive.current) { discardPreview(result); return }
      downloadedPreview.current = result
      setPreview(result)
      setCandidateID(result.candidates[0].candidate_id)
      setSelected(result.candidates[0].resources.map((r) => r.id))
    })().finally(() => { pending.current = undefined })
    return pending.current
  }
  useEffect(() => {
    alive.current = true
    // A supplied source means the user already chose Get. Keep its download
    // in the import flow and reuse the request during StrictMode effect replay.
    if (source && !initialPreview) void run(loadPreview)
    return () => {
      alive.current = false
      if (downloadedPreview.current) {
        discardPreview(downloadedPreview.current)
        downloadedPreview.current = undefined
      }
    }
  }, [])
  const close = () => {
    if (busy && preview) return
    if (preview) {
      discardPreview(preview)
      downloadedPreview.current = undefined
    }
    onClose()
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent
        className="max-h-[min(90dvh,56rem)] overflow-y-auto"
        onInteractOutside={(event) => {
          if (busy && preview) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {t(plan ? 'market.import.confirmTitle' : 'market.import.title')}
          </DialogTitle>
          <DialogDescription>
            {t(plan ? 'market.import.confirmHelp' : source ? 'market.contents.selectHelp' : 'market.import.help')}
          </DialogDescription>
        </DialogHeader>
        {preview?.character && (
          <CompatibilityReport preview={preview.character} />
        )}
        {!preview && source && <p role="status" className="text-sm text-muted-foreground">{t(busy ? 'market.import.downloading' : 'market.contents.failed')}</p>}
        {!preview && !source && (
          <FieldGroup>
            <Field>
              <FieldLabel>{t('market.import.source')}</FieldLabel>
              <Select
                value={sourceKind}
                onValueChange={(value) => {
                  setSourceKind(value)
                  setFile(undefined)
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="github">GitHub</SelectItem>
                  <SelectItem value="https_zip">
                    {t('market.import.url')}
                  </SelectItem>
                  <SelectItem value="file">
                    {t('market.import.file')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {sourceKind === 'file' ? (
              <Field>
                <FieldLabel htmlFor="market-file">
                  {t('market.import.file')}
                </FieldLabel>
                <Input
                  id="market-file"
                  type="file"
                  accept=".zip,.png,.json"
                  onChange={(event) => setFile(event.target.files?.[0])}
                />
              </Field>
            ) : (
              <>
                <Field>
                  <FieldLabel htmlFor="market-url">
                    {t('market.import.url')}
                  </FieldLabel>
                  <Input
                    id="market-url"
                    value={url}
                    onChange={(event) => setURL(event.target.value)}
                    placeholder="https://github.com/owner/repository"
                  />
                </Field>
                {sourceKind === 'github' && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field>
                      <FieldLabel htmlFor="market-ref">
                        {t('market.import.ref')}
                      </FieldLabel>
                      <Input
                        id="market-ref"
                        value={ref}
                        onChange={(event) => setRef(event.target.value)}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="market-path">
                        {t('market.import.path')}
                      </FieldLabel>
                      <Input
                        id="market-path"
                        value={path}
                        onChange={(event) => setPath(event.target.value)}
                      />
                    </Field>
                  </div>
                )}
              </>
            )}
          </FieldGroup>
        )}
        {preview && !plan && (
          <FieldGroup>
            {preview.candidates.length > 1 && <Field>
              <FieldLabel>{t('market.import.package')}</FieldLabel>
              <Select
                value={candidateID}
                onValueChange={(id) => {
                  setCandidateID(id)
                  setSelected(
                    preview.candidates
                      .find((c) => c.candidate_id === id)
                      ?.resources.map((r) => r.id) || [],
                  )
                  setGrants({})
                  setNames({})
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {preview.candidates.map((c) => (
                    <SelectItem key={c.candidate_id} value={c.candidate_id}>
                      {c.package.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>}
            {candidate && <ImportResourcePicker previewID={preview.preview_id} candidate={candidate} selected={selected} onChange={setSelected} />}

            <div className="space-y-3">
              {resources.filter((resource) => resource.kind === 'skill' || resource.extension).map((resource) => (
                <div key={resource.id} className="space-y-3 rounded-lg border p-3">
                  <p className="text-sm font-medium">{resource.name}</p>
                  {resource.kind === 'skill' &&
                    !installation && (
                      <Field>
                        <FieldLabel htmlFor={`name-${resource.id}`}>
                          {t('market.import.localName')}
                        </FieldLabel>
                        <Input
                          id={`name-${resource.id}`}
                          value={names[resource.id] ?? resource.name}
                          onChange={(event) =>
                            setNames((current) => ({
                              ...current,
                              [resource.id]: event.target.value,
                            }))
                          }
                        />
                      </Field>
                    )}
                  {resource.extension && (
                    <div className="space-y-2 rounded-md bg-muted p-3">
                      <p className="text-xs text-muted-foreground">
                        {t('market.import.permissions')}
                      </p>
                      {[
                        ...resource.extension.manifest.permissions.required,
                        ...(resource.extension.manifest.permissions.optional ||
                          []),
                      ].map((permission) => (
                        <Field key={permission} orientation="horizontal">
                          <Checkbox
                            id={`permission-${resource.id}-${permission}`}
                            checked={(grants[resource.id] || []).includes(
                              permission,
                            )}
                            onCheckedChange={(checked) =>
                              setGrants((current) => ({
                                ...current,
                                [resource.id]: checked
                                  ? [
                                      ...(current[resource.id] || []),
                                      permission,
                                    ]
                                  : (current[resource.id] || []).filter(
                                      (p) => p !== permission,
                                    ),
                              }))
                            }
                          />
                          <FieldLabel
                            htmlFor={`permission-${resource.id}-${permission}`}
                          >
                            {t(`platform.permission.${permission}`)}
                            {resource.extension?.manifest.permissions.required.includes(
                              permission,
                            )
                              ? ` · ${t('market.import.required')}`
                              : ''}
                          </FieldLabel>
                        </Field>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
            {resources.some((r) => r.kind === 'skill') && !installation && (
              <Field>
                <FieldLabel>{t('market.import.scope')}</FieldLabel>
                <Select value={scope} onValueChange={setScope}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="user">
                      {t('market.import.global')}
                    </SelectItem>
                    <SelectItem value="workspace">
                      {t('market.import.project')}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            )}
            {canCreateBook && (
              <FieldSet>
                <FieldLegend id="market-import-mode" variant="label">{t('market.import.bookDestination')}</FieldLegend>
                <RadioGroup
                  aria-labelledby="market-import-mode"
                  value={bookDestination}
                  onValueChange={(value) => {
                    if (value === 'new' || value === 'existing') setBookDestination(value)
                  }}
                  disabled={busy}
                >
                  <Field orientation="horizontal" data-disabled={busy}>
                    <RadioGroupItem id="market-new-book" value="new" />
                    <FieldLabel htmlFor="market-new-book">{t('market.import.newBook')}</FieldLabel>
                  </Field>
                  <Field orientation="horizontal" data-disabled={busy}>
                    <RadioGroupItem id="market-existing-book" value="existing" />
                    <FieldLabel htmlFor="market-existing-book">{t('market.import.existingBook')}</FieldLabel>
                  </Field>
                </RadioGroup>
              </FieldSet>
            )}
            {needsProject && !creatingBook && (
              <Field data-disabled={busy || !!installation}>
                <FieldLabel htmlFor="market-target-book">{t('market.import.project')}</FieldLabel>
                <Select
                  value={projectID}
                  onValueChange={setProjectID}
                  disabled={busy || !!installation}
                >
                  <SelectTrigger id="market-target-book" className="w-full min-w-0">
                    <SelectValue
                      placeholder={t('market.import.selectProject')}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {books
                        .filter((book) => book.project_id)
                        .map((book) => (
                          <SelectItem
                            key={book.project_id}
                            value={book.project_id!}
                          >
                            {book.name}
                          </SelectItem>
                        ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            )}
            {creatingBook && (
              <Field data-disabled={busy}>
                <FieldLabel htmlFor="market-book-title">{t('market.import.bookTitle')}</FieldLabel>
                <Input id="market-book-title" value={bookTitle} disabled={busy} onChange={(event) => setBookTitle(event.target.value)} />
                <FieldDescription>{t('market.import.newBookHelp')}</FieldDescription>
              </Field>
            )}
            {(installation ||
              resources.some(
                (resource) => resource.kind === 'project.cover',
              )) && (
              <Field orientation="horizontal">
                <Checkbox
                  id="replace-modified"
                  checked={replace}
                  onCheckedChange={(checked) => setReplace(checked === true)}
                />
                <FieldLabel htmlFor="replace-modified">
                  {t('market.import.replaceModified')}
                </FieldLabel>
              </Field>
            )}
          </FieldGroup>
        )}
        {plan && (
          <div className="space-y-3">
            <h3 className="font-medium">{plan.installation.package.name}</h3>
            <ul className="divide-y rounded-lg border">
              {plan.items.map((item) => (
                <li
                  key={item.resource_id}
                  className="flex flex-wrap justify-between gap-2 p-3"
                >
                  <span className="break-words">
                    {item.name || item.local.id}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t(`market.actions.${item.action}`)} ·{' '}
                    {t(`market.kinds.${item.local.kind}`)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground break-all">
              {preview?.source.commit
                ? t('market.import.commit', { commit: preview.source.commit })
                : preview?.source.url || preview?.source.filename}
            </p>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy && !!preview}
            onClick={plan ? () => setPlan(undefined) : close}
          >
            {t(plan ? 'market.back' : 'common.cancel')}
          </Button>
          <Button
            disabled={
              busy ||
              (!preview && !url && !file) ||
              (!!preview &&
                !plan &&
                (!chosen.length ||
                  (needsProject && (creatingBook ? !bookTitle.trim() : !projectID)) ||
                  missingConsent))
            }
            onClick={() =>
              void run(async () => {
                if (!preview) await loadPreview()
                else if (!plan) {
                  let targetProject = projectID
                  if (creatingBook) {
                    const created = await createBook(bookTitle.trim())
                    targetProject = created.project_id
                    // Retain the created target even if planning fails, so retry never creates it twice.
                    setProjectID(targetProject)
                    setBookDestination('existing')
                    setBooks((current) => [...current, {
                      project_id: targetProject, path: created.workspace,
                      name: created.book_meta.title, author: created.book_meta.author || '', last_opened_at: '',
                    }])
                  }
                  setPlan(
                    await exchange<Plan>('/plans', {
                      preview_id: preview.preview_id,
                      candidate_id: candidateID,
                      resources: selected,
                      project_id: targetProject,
                      skill_scope: scope,
                      installation_id: installation?.installation_id,
                      grants,
                      names,
                      replace_modified: replace,
                      update_mode: installation?.update_mode || 'manual',
                    }),
                  )
                } else {
                  const installed = await exchange<Installation>(
                    `/plans/${plan.plan_id}/apply`,
                    {},
                  )
                  toast.success(t('market.import.done'))
                  await onInstalled(installed)
                  if (preview) {
                    discardPreview(preview)
                    downloadedPreview.current = undefined
                  }
                  onClose()
                }
              })
            }
          >
            {t(
              busy
                ? !preview ? 'market.import.downloading' : 'market.working'
                : plan
                  ? 'market.import.install'
                  : preview
                    ? creatingBook ? 'market.import.createAndReview' : 'market.import.review'
                    : source ? 'market.contents.retry' : 'market.import.preview',
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
