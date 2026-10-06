import { expect, test } from '../support/fixtures'
import { createAndOpenBook } from '../support/api'
import { expectAgentChatReply, openWritingAgent } from '../support/agent-chat'
import { getModelStatus, releaseDelayedRequest } from '../support/model'

test('writing re-anchors each over-budget live stream onto canonical history', async ({ page, request }) => {
  test.setTimeout(120_000)
  // The megabytes of reasoning that exceed the display budget are also model
  // context for the next calls; give those calls room so the Run keeps going.
  const original = await (await request.get('/api/settings')).json() as { user: { model_profiles: Array<Record<string, unknown>> } }
  const configured = await request.patch('/api/settings', { data: { layer: 'user', changes: {
    model_profiles: original.user.model_profiles.map(profile => ({ ...profile, context_window_tokens: 1_000_000 })),
  } } })
  expect(configured.ok(), await configured.text()).toBe(true)
  await createAndOpenBook(request, 'Live budget')
  await page.goto('/')
  const composer = await openWritingAgent(page)
  const streamRequests: string[] = []
  page.on('request', (value) => {
    if (value.url().includes('/chat/stream')) streamRequests.push(value.url())
  })
  const marker = 'E2E_LIVE_BUDGET'
  await composer.fill(marker)
  await page.locator('[data-action="send"]').filter({ visible: true }).click()
  try {
    // The third model call is held open, so the Run is still active after the
    // two tool batches that each gave an over-budget connection its idle boundary.
    await expect.poll(async () => (await getModelStatus(request)).delayed_waiting_by_marker[marker] ?? 0).toBe(1)
    await expect.poll(() => streamRequests.filter((url) => /[?&]after=\d+/.test(url)).length).toBe(2)
    await expect(page.locator('[data-action="stop"]').filter({ visible: true })).toBeVisible()
    expect(await page.getByRole('alert').filter({ visible: true }).allTextContents()).toEqual([])
    // The resumed connection is ordinary streaming, not a recovery in progress.
    await expect(page.getByText(/正在从持久化状态恢复/)).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath('resumed.png') })
    await releaseDelayedRequest(request, marker)
    await expectAgentChatReply(page, 'Live budget complete.')
    // Nothing was dropped at the boundary, so the omission notice stays hidden.
    await expect(page.getByText(/较早的实时轨迹已超出展示预算/)).toHaveCount(0)
    expect(streamRequests.filter((url) => /[?&]after=\d+/.test(url))).toHaveLength(2)
    await expect(page.locator('[data-action="send"]').filter({ visible: true })).toBeVisible()
    await expect(page.getByText(/正在从持久化状态恢复/)).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath('settled.png') })
  } finally {
    await releaseDelayedRequest(request, marker)
    const restored = await request.patch('/api/settings', { data: { layer: 'user', changes: { model_profiles: original.user.model_profiles } } })
    expect(restored.ok(), await restored.text()).toBe(true)
  }
})

test('writing re-anchors in the middle of a long tool-free thinking segment without losing text', async ({ page, request }) => {
  test.setTimeout(180_000)
  const settings = await (await request.get('/api/settings')).json() as { effective: Record<string, unknown>; user: { model_profiles: Array<Record<string, unknown>> } }
  const configured = await request.patch('/api/settings', { data: { layer: 'user', changes: {
    model_profiles: settings.user.model_profiles.map(profile => ({ ...profile, context_window_tokens: 1_000_000 })),
  } } })
  expect(configured.ok(), await configured.text()).toBe(true)
  // Expanded thinking exposes the whole segment text, which is what a lost or
  // doubled seam between the history prefix and the live suffix would change.
  await page.route(/\/api\/(?:projects\/[^/]+\/)?settings$/, route => route.fulfill({ json: {
    ...settings, effective: { ...settings.effective, auto_expand_thinking: true },
  } }))
  await createAndOpenBook(request, 'Live budget thinking')
  await page.goto('/')
  let composer = await openWritingAgent(page)
  const resumes: string[] = []
  page.on('request', (value) => {
    if (/\/chat\/stream\?.*[?&]after=\d+/.test(value.url())) resumes.push(value.url())
  })
  const held = 'E2E_LIVE_BUDGET_THINKING'
  const heldAtEnd = 'E2E_LIVE_BUDGET_THINKING_END'
  const prefix = 'ALPHA-START ' + 'Budget reasoning with no tool boundary. '.repeat(200 * 200)
  const thinking = page.getByRole('region', { name: '思考内容', exact: true }).filter({ visible: true })
  const thinkingText = async () => (await thinking.textContent()) ?? ''
  await composer.fill(held)
  await page.locator('[data-action="send"]').filter({ visible: true }).click()
  try {
    await expect.poll(async () => (await getModelStatus(request)).delayed_waiting_by_marker[held] ?? 0).toBe(1)
    // No tool call ever closed a part: the server re-anchored mid-segment.
    await expect.poll(() => resumes.length).toBeGreaterThanOrEqual(1)
    await expect.poll(async () => (await thinkingText()).length, { timeout: 60_000 }).toBeGreaterThanOrEqual(prefix.length - 1)
    expect((await thinkingText()).length).toBeLessThanOrEqual(prefix.length)
    expect((await thinkingText()).startsWith('ALPHA-START Budget reasoning')).toBe(true)

    // A reload during the same segment must not replay it again.
    const resumedBeforeReload = resumes.length
    await page.reload()
    composer = await openWritingAgent(page)
    await expect.poll(() => resumes.length).toBeGreaterThan(resumedBeforeReload)

    // The rest of the segment arrives on the connection resumed after the
    // reload and joins the history prefix exactly once.
    await releaseDelayedRequest(request, held)
    await expect.poll(async () => (await getModelStatus(request)).delayed_waiting_by_marker[heldAtEnd] ?? 0).toBe(1)
    await expect.poll(async () => (await thinkingText()).endsWith('OMEGA-END'), { timeout: 60_000 }).toBe(true)
    expect((await thinkingText()).length).toBe(prefix.length + 'OMEGA-END'.length)
    expect((await thinkingText()).startsWith('ALPHA-START Budget reasoning')).toBe(true)
    expect(await page.getByRole('alert').filter({ visible: true }).allTextContents()).toEqual([])
    await expect(page.getByText(/较早的实时轨迹已超出展示预算/)).toHaveCount(0)

    await releaseDelayedRequest(request, heldAtEnd)
    await expectAgentChatReply(page, 'Live thinking budget complete.')
    await expect(page.locator('[data-action="send"]').filter({ visible: true })).toBeVisible()
  } finally {
    await releaseDelayedRequest(request, held)
    await releaseDelayedRequest(request, heldAtEnd)
    const restored = await request.patch('/api/settings', { data: { layer: 'user', changes: { model_profiles: settings.user.model_profiles } } })
    expect(restored.ok(), await restored.text()).toBe(true)
  }
})
