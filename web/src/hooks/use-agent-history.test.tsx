import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { SessionMessagesPage } from '@/lib/api'
import { writingAgentChatClient } from './agent-chat-client'
import { useWritingAgentHistory } from './use-agent-history'

const page: SessionMessagesPage = {
  messages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Continue' }] }],
  nextBefore: '0', hasMore: false, total: 1,
}

const refreshedPage: SessionMessagesPage = {
  messages: [...page.messages, { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: 'Done' }] }],
  nextBefore: '0', hasMore: false, total: 2,
}

describe.each(['writing', 'agent-chat'])('%s history refresh', (surface) => {
  it('preserves live approval events when a history response arrives after streaming starts', async () => {
    let finishHistory!: (page: SessionMessagesPage) => void
    const pending = new Promise<SessionMessagesPage>((resolve) => { finishHistory = resolve })
    const getMessagesPage = vi.fn().mockReturnValue(pending)
    const setMessages = vi.fn()
    const client = { ...writingAgentChatClient, fixedSessionId: surface === 'agent-chat' ? 'session-1' : undefined, getMessagesPage }
    const { result, rerender } = renderHook(({ transportStreaming }) => (
      useWritingAgentHistory({ client, setMessages, transportStreaming })
    ), { initialProps: { transportStreaming: false } })

    let refresh!: Promise<void>
    act(() => { refresh = result.current.loadHistory('session-1') })
    rerender({ transportStreaming: true })
    await act(async () => {
      finishHistory(page)
      await refresh
    })
    expect(setMessages).not.toHaveBeenCalled()

    await act(async () => { await result.current.loadHistory('session-1') })
    expect(getMessagesPage).toHaveBeenCalledTimes(1)
  })

  it('allows explicit recovery and idle refreshes to replace history', async () => {
    const getMessagesPage = vi.fn().mockResolvedValue(page)
    const setMessages = vi.fn()
    const client = { ...writingAgentChatClient, fixedSessionId: surface === 'agent-chat' ? 'session-1' : undefined, getMessagesPage }
    const { result, rerender } = renderHook(({ transportStreaming }) => (
      useWritingAgentHistory({ client, setMessages, transportStreaming })
    ), { initialProps: { transportStreaming: true } })

    await act(async () => { await result.current.loadHistoryAuthoritative('session-1') })
    expect(setMessages).toHaveBeenLastCalledWith(page.messages)
    rerender({ transportStreaming: false })
    await act(async () => { await result.current.loadHistory('session-1') })
    expect(getMessagesPage).toHaveBeenCalledTimes(2)
    expect(setMessages).toHaveBeenLastCalledWith(page.messages)
  })

  it('queues an idle refresh behind an in-flight authoritative reload instead of superseding it', async () => {
    let finishAuthoritative!: (page: SessionMessagesPage) => void
    const pending = new Promise<SessionMessagesPage>((resolve) => { finishAuthoritative = resolve })
    const getMessagesPage = vi.fn().mockReturnValueOnce(pending).mockResolvedValueOnce(refreshedPage)
    const setMessages = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const client = { ...writingAgentChatClient, fixedSessionId: surface === 'agent-chat' ? 'session-1' : undefined, getMessagesPage }
    const { result } = renderHook(() => useWritingAgentHistory({ client, setMessages }))

    let authoritative!: Promise<void>
    let refresh!: Promise<void>
    act(() => {
      authoritative = result.current.loadHistoryAuthoritative('session-1')
      refresh = result.current.loadHistory('session-1')
    })
    expect(getMessagesPage).toHaveBeenCalledTimes(1)
    await act(async () => {
      finishAuthoritative(page)
      await expect(authoritative).resolves.toBeUndefined()
      await refresh
    })

    expect(setMessages.mock.calls).toEqual([[page.messages], [refreshedPage.messages]])
    expect(consoleError).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('ends an idle refresh quietly when a newer reload owns the display', async () => {
    let finishOlder!: (page: SessionMessagesPage) => void
    const pending = new Promise<SessionMessagesPage>((resolve) => { finishOlder = resolve })
    const getMessagesPage = vi.fn().mockReturnValueOnce(pending).mockResolvedValueOnce(refreshedPage)
    const setMessages = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const client = { ...writingAgentChatClient, fixedSessionId: surface === 'agent-chat' ? 'session-1' : undefined, getMessagesPage }
    const { result } = renderHook(() => useWritingAgentHistory({ client, setMessages }))

    let older!: Promise<void>
    let newer!: Promise<void>
    act(() => {
      older = result.current.loadHistory('session-1')
      newer = result.current.loadHistory('session-1')
    })
    await act(async () => {
      await newer
      finishOlder(page)
      await older
    })

    expect(setMessages.mock.calls).toEqual([[refreshedPage.messages]])
    expect(consoleError).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })
})
