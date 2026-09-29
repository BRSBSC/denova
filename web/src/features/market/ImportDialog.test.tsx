import { StrictMode, type ReactElement } from 'react'
import { act, fireEvent, render as renderComponent, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { createBook } from '@/lib/api'
import { BookCreationProvider } from '@/components/workbench/book-creation'
import { ImportDialog } from './ImportDialog'
import { discardPreview, previewSource, exchange, type Preview } from './api'
vi.mock('@/lib/api', () => ({ getBooks: vi.fn().mockResolvedValue([]), createBook: vi.fn() }))
vi.mock('./api', async (original) => ({ ...await original<typeof import('./api')>(), exchange: vi.fn(), previewSource: vi.fn(), discardPreview: vi.fn() }))
const beforeCreate = vi.fn<() => Promise<boolean>>()
const onCreated = vi.fn<(workspace: string) => Promise<void>>()
const render = (ui: ReactElement) => renderComponent(ui, {
  wrapper: ({ children }) => <BookCreationProvider value={{ beforeCreate, onCreated }}>{children}</BookCreationProvider>,
})
const preview: Preview = {
  preview_id: 'frozen', source: { kind: 'github', url: 'https://github.com/test/package' }, expires_at: '2030-01-01',
  candidates: [{ candidate_id: 'first', package: { id: 'first', name: 'Other package' }, format: 'skill', resources: [] }, {
    candidate_id: 'second', package: { id: 'second', name: 'Chosen package' }, format: 'denova.resource-pack', resources: [
      { id: 'lore', kind: 'lore.collection', name: 'Not selected', path: 'lore.json', digest: '1' },
      { id: 'image', kind: 'preset.image', name: 'Selected image', path: 'image.json', requires: ['style'], digest: '2' },
      { id: 'style', kind: 'style.reference', name: 'Required style', path: 'style.md', digest: '3' },
    ],
  }],
}
beforeEach(() => {
  vi.mocked(exchange).mockReset()
  vi.mocked(previewSource).mockReset()
  vi.mocked(discardPreview).mockReset()
  vi.mocked(createBook).mockReset()
  beforeCreate.mockReset().mockResolvedValue(true)
  onCreated.mockReset().mockResolvedValue(undefined)
})
it('plans exactly the selected candidate and resources, while displaying its dependency', async () => {
  vi.mocked(exchange).mockResolvedValue({ plan_id: 'plan', items: [], installation: { package: { name: 'Chosen package' } } })
  render(<ImportDialog preview={{ ...preview, candidates: [preview.candidates[1]] }} onClose={vi.fn()} onInstalled={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '清空选择' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Selected image' }))
  expect(screen.getByText(/Selected image/)).toBeVisible()
  expect(screen.getByText(/Required style/)).toBeVisible()
  expect(screen.queryByRole('checkbox', { name: 'Not selected' })).not.toBeInTheDocument()
  expect(screen.queryByText('目标作品')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('来源链接')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '生成安装计划' }))
  await waitFor(() => expect(exchange).toHaveBeenCalledWith('/plans', expect.objectContaining({ preview_id: 'frozen', candidate_id: 'second', resources: ['image'] })))
})
it('releases the owned preview on cancel', () => {
  const onClose = vi.fn()
  render(<ImportDialog preview={{ ...preview, candidates: [preview.candidates[1]] }} onClose={onClose} onInstalled={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  expect(onClose).toHaveBeenCalledOnce()
  expect(discardPreview).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ preview_id: 'frozen' }))
  expect(exchange).not.toHaveBeenCalled()
})

it('submits a complete selected collection without adding another collection or openings', async () => {
  vi.mocked(exchange).mockResolvedValue({ plan_id: 'plan', items: [], installation: { package: { name: 'Story package' } } })
  const groupedPreview: Preview = { ...preview, candidates: [{
    candidate_id: 'story', package: { id: 'story', name: 'Story package' }, format: 'denova.resource-pack', resources: [
      { id: 'harbor', kind: 'lore.collection', name: 'Harbor', path: 'harbor.json', digest: '1' },
      { id: 'island', kind: 'lore.collection', name: 'Island', path: 'island.json', digest: '2' },
      { id: 'dawn', kind: 'game.openings', name: 'Dawn', path: 'dawn.json', digest: '3' },
      { id: 'dusk', kind: 'game.openings', name: 'Dusk', path: 'dusk.json', digest: '4' },
    ],
  }] }
  render(<ImportDialog preview={groupedPreview} projectID="target" onClose={vi.fn()} onInstalled={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '清空选择' }))
  fireEvent.change(screen.getByRole('textbox', { name: '搜索名称、描述或类型' }), { target: { value: 'Harbor' } })
  fireEvent.click(screen.getByRole('checkbox', { name: '全选资料的搜索结果' }))
  fireEvent.click(screen.getByRole('button', { name: '生成安装计划' }))
  await waitFor(() => expect(exchange).toHaveBeenCalledWith('/plans', expect.objectContaining({
    preview_id: 'frozen', candidate_id: 'story', resources: ['harbor'], project_id: 'target',
  })))
})

it('creates a book for lore and reuses it when planning fails', async () => {
  const user = userEvent.setup()
  vi.mocked(createBook).mockResolvedValue({ project_id: 'new-project', workspace: '/books/new', book_meta: { title: 'New world' } } as Awaited<ReturnType<typeof createBook>>)
  vi.mocked(exchange).mockRejectedValueOnce(new Error('Plan failed')).mockResolvedValueOnce({ plan_id: 'plan', items: [], installation: { package: { name: 'Chosen package' } } })
  render(<ImportDialog preview={{ ...preview, candidates: [{ ...preview.candidates[1], resources: [preview.candidates[1].resources[0]] }] }} onClose={vi.fn()} onInstalled={vi.fn()} />)
  await user.click(screen.getByRole('radio', { name: '导入成新书籍' }))
  expect(screen.queryByRole('combobox', { name: '目标作品' })).not.toBeInTheDocument()
  const review = screen.getByRole('button', { name: '创建书籍并生成计划' })
  expect(review).toBeDisabled()
  expect(createBook).not.toHaveBeenCalled()
  await user.type(screen.getByRole('textbox', { name: '新书名称' }), '  New world  ')
  await user.click(review)
  await screen.findByText('Plan failed')
  expect(createBook).toHaveBeenCalledWith('New world')
  expect(beforeCreate).toHaveBeenCalledOnce()
  expect(onCreated).toHaveBeenCalledExactlyOnceWith('/books/new')
  expect(beforeCreate.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(createBook).mock.invocationCallOrder[0])
  expect(onCreated.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(exchange).mock.invocationCallOrder[0])
  expect(exchange).toHaveBeenCalledWith('/plans', expect.objectContaining({ project_id: 'new-project', resources: ['lore'] }))
  await user.click(screen.getByRole('button', { name: '生成安装计划' }))
  await screen.findByText('确认安装计划')
  expect(createBook).toHaveBeenCalledTimes(1)
  expect(onCreated).toHaveBeenCalledTimes(1)
})

it('does not create or plan a book when workspace drafts cannot be saved', async () => {
  const user = userEvent.setup()
  beforeCreate.mockResolvedValue(false)
  render(<ImportDialog preview={{ ...preview, candidates: [{ ...preview.candidates[1], resources: [preview.candidates[1].resources[0]] }] }} onClose={vi.fn()} onInstalled={vi.fn()} />)
  await user.click(screen.getByRole('radio', { name: '导入成新书籍' }))
  await user.type(screen.getByRole('textbox', { name: '新书名称' }), 'New world')
  await user.click(screen.getByRole('button', { name: '创建书籍并生成计划' }))
  expect(beforeCreate).toHaveBeenCalledOnce()
  expect(createBook).not.toHaveBeenCalled()
  expect(exchange).not.toHaveBeenCalled()
  expect(onCreated).not.toHaveBeenCalled()
})

it('keeps the new-book form after creation fails and never plans without a project', async () => {
  const user = userEvent.setup()
  vi.mocked(createBook).mockRejectedValueOnce(new Error('Book creation failed'))
  render(<ImportDialog preview={{ ...preview, candidates: [{ ...preview.candidates[1], resources: [preview.candidates[1].resources[0]] }] }} onClose={vi.fn()} onInstalled={vi.fn()} />)
  await user.click(screen.getByRole('radio', { name: '导入成新书籍' }))
  expect(screen.queryByRole('combobox', { name: '目标作品' })).not.toBeInTheDocument()
  await user.type(screen.getByRole('textbox', { name: '新书名称' }), 'New world')
  await user.click(screen.getByRole('button', { name: '创建书籍并生成计划' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Book creation failed')
  expect(screen.getByRole('textbox', { name: '新书名称' })).toHaveValue('New world')
  expect(exchange).not.toHaveBeenCalled()
})

it('asks for the import mode before showing the corresponding book fields', async () => {
  const user = userEvent.setup()
  render(<ImportDialog preview={{ ...preview, candidates: [{ ...preview.candidates[1], resources: [preview.candidates[1].resources[0]] }] }} onClose={vi.fn()} onInstalled={vi.fn()} />)
  const mode = screen.getByRole('radiogroup', { name: '导入方式' })
  expect(mode).toBeVisible()
  expect(screen.getByRole('radio', { name: '导入到已有书籍' })).toBeChecked()
  expect(screen.getByRole('combobox', { name: '目标作品' })).toBeVisible()
  expect(screen.queryByRole('textbox', { name: '新书名称' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('radio', { name: '导入成新书籍' }))
  await user.type(screen.getByRole('textbox', { name: '新书名称' }), 'New world')
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  await user.click(screen.getByRole('radio', { name: '导入到已有书籍' }))
  expect(screen.getByRole('combobox', { name: '目标作品' })).toBeVisible()
  expect(screen.queryByRole('textbox', { name: '新书名称' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '生成安装计划' })).toBeDisabled()
  await user.click(screen.getByRole('radio', { name: '导入成新书籍' }))
  expect(screen.getByRole('textbox', { name: '新书名称' })).toHaveValue('New world')
  expect(createBook).not.toHaveBeenCalled()
})

const downloaded: Preview = { ...preview, candidates: [preview.candidates[1]] }
it('downloads a supplied source once in StrictMode and releases it on close', async () => {
  vi.mocked(previewSource).mockResolvedValue(downloaded)
  const onClose = vi.fn()
  const view = render(<StrictMode><ImportDialog source={preview.source} onClose={onClose} onInstalled={vi.fn()} /></StrictMode>)
  expect(screen.getByRole('status')).toHaveTextContent('正在下载并检查资源包')
  expect(await screen.findByRole('checkbox', { name: 'Selected image' })).toBeChecked()
  expect(previewSource).toHaveBeenCalledExactlyOnceWith(preview.source)
  expect(screen.queryByLabelText('来源链接')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  expect(onClose).toHaveBeenCalledOnce()
  view.unmount()
  expect(discardPreview).toHaveBeenCalledExactlyOnceWith(downloaded)
})
it('allows retry after a source download fails', async () => {
  vi.mocked(previewSource).mockRejectedValueOnce(new Error('Download failed')).mockResolvedValueOnce(downloaded)
  render(<ImportDialog source={preview.source} onClose={vi.fn()} onInstalled={vi.fn()} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Download failed')
  fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
  expect(await screen.findByRole('checkbox', { name: 'Selected image' })).toBeChecked()
  expect(previewSource).toHaveBeenCalledTimes(2)
})
it('allows cancelling a download and releases its late result', async () => {
  let resolve!: (result: Preview) => void
  vi.mocked(previewSource).mockReturnValue(new Promise(done => { resolve = done }))
  const onClose = vi.fn()
  const view = render(<ImportDialog source={preview.source} onClose={onClose} onInstalled={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  expect(onClose).toHaveBeenCalledOnce()
  view.unmount()
  await act(async () => resolve(downloaded))
  expect(discardPreview).toHaveBeenCalledExactlyOnceWith(downloaded)
})
