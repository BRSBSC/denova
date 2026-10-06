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
  // This megabyte-sized history is slow enough for a background refresh to
  // overlap the canonical reload that settles the Run.
  const recoveryWarnings: string[] = []
  page.on('console', (message) => {
    if (message.text().includes('failed to inspect or recover writing Agent runtime')) recoveryWarnings.push(message.text())
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
    expect(recoveryWarnings).toEqual([])
    await page.screenshot({ path: test.info().outputPath('settled.png') })
  } finally {
    await releaseDelayedRequest(request, marker)
    const restored = await request.patch('/api/settings', { data: { layer: 'user', changes: { model_profiles: original.user.model_profiles } } })
    expect(restored.ok(), await restored.text()).toBe(true)
  }
})
