import { render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { remoteAccessQuery } from '@/features/remote-access/api'
import { queryClient } from '@/lib/query-client'
import { ImportSourceFields } from './ImportSourceFields'

afterEach(() => { queryClient.clear() })

it.each([
  { local: true, hostSources: 1 },
  { local: false, hostSources: 0 },
])('offers sources that name a host path only to the host browser: local=$local', ({ local, hostSources }) => {
  queryClient.setQueryData(remoteAccessQuery.queryKey, { local, authenticated: true })
  render(<ImportSourceFields value={{ kind: 'github', url: '' }} onChange={vi.fn()} busy={false} run={vi.fn()} onImportedSource={vi.fn()} />)
  expect(screen.getByRole('radio', { name: 'GitHub' })).toBeInTheDocument()
  expect(screen.getByRole('radio', { name: '本地文件' })).toBeInTheDocument()
  expect(screen.queryAllByRole('radio', { name: '本地扩展目录（开发）' })).toHaveLength(hostSources)
  expect(screen.queryAllByRole('button', { name: '导入源码到工作台' })).toHaveLength(hostSources)
})
