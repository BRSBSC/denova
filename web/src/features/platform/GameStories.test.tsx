import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StoryPickerProps } from '@/features/interactive/components/StoryPicker'
import { remoteAccessQuery } from '@/features/remote-access/api'
import { queryClient } from '@/lib/query-client'
import { GameStories } from './GameStories'

afterEach(() => { vi.unstubAllGlobals(); queryClient.clear() })

function mount(local: boolean) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({ error: 'local only' }), { status: 403, headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fetchMock)
  queryClient.setQueryData(remoteAccessQuery.queryKey, { local, authenticated: true })
  render(<QueryClientProvider client={queryClient}>
    <GameStories projectId="book" active builtinPicker={{ stories: [] } as unknown as StoryPickerProps}><p>Built-in story</p></GameStories>
  </QueryClientProvider>)
  return fetchMock
}

describe('GameStories', () => {
  it('keeps the built-in game usable without calling the local-only management API from a remote browser', async () => {
    const fetchMock = mount(false)
    await screen.findByText('Built-in story')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('loads installed games on the machine that runs Denova', async () => {
    const fetchMock = mount(true)
    await waitFor(() => expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual(expect.arrayContaining([
      '/api/platform/manage/catalog', '/api/platform/manage/instances', '/api/platform/manage/game-preferences',
    ])))
  })
})
