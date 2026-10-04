import { expect, test } from '../support/fixtures'
import { writeFile } from 'node:fs/promises'
import { createAndOpenBook, createStartedStory } from '../support/api'
import { openWritingAgent } from '../support/agent-chat'
import { getModelStatus, releaseDelayedRequest } from '../support/model'

for (const product of ['writing', 'game'] as const) {
  for (const display of ['expanded', 'collapsed', 'collapsed-fast'] as const) {
    test(`${product} long streaming thinking keeps rendering overhead bounded while ${display}`, async ({ page, request }, testInfo) => {
      test.setTimeout(120_000)
      await createAndOpenBook(request, 'Thinking memory')
      if (product === 'game') await createStartedStory(request, 'Thinking memory')
      const settings = await (await request.get('/api/settings')).json()
      await page.route(/\/api\/(?:projects\/[^/]+\/)?settings$/, route => route.fulfill({ json: {
        ...settings, effective: { ...settings.effective, auto_expand_thinking: true, theme: product === 'game' ? 'dark' : 'light' },
      } }))
      await page.goto('/')
      if (product === 'game') await page.getByLabel('工作台侧边栏').getByRole('button', { name: '游戏', exact: true }).click()
      const composer = product === 'writing' ? await openWritingAgent(page) : page.getByPlaceholder(/你要做什么/)
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('HeapProfiler.collectGarbage')
      const baseline = await cdp.send('Runtime.getHeapUsage')
      await composer.fill(display === 'collapsed-fast' ? 'E2E_THINKING_STRESS E2E_THINKING_FAST' : 'E2E_THINKING_STRESS')
      await page.locator('[data-action="send"]').filter({ visible: true }).click()
      const measurements: Array<{ stage: number; characters: number; elements: number; heapBytes: number }> = []
      try {
        for (let stage = 1; stage <= 3; stage += 1) {
          const marker = `E2E_THINKING_STAGE_${stage}`
          await expect.poll(async () => (await getModelStatus(request)).delayed_waiting_by_marker[marker] ?? 0).toBe(1)
          const thinking = page.getByRole('region', { name: '思考内容', exact: true }).filter({ visible: true })
          if (display === 'expanded' || stage === 1) {
            await expect(thinking).toContainText('Review the saved chapter')
            await expect.poll(async () => (await thinking.textContent())?.length ?? 0).toBeGreaterThanOrEqual(48640 * stage - 1)
          }
          if (display !== 'expanded') {
            if (stage === 1) await page.getByRole('button', { name: '收起思考', exact: true }).click()
            await expect(thinking).toHaveCount(0)
          }
          await cdp.send('HeapProfiler.collectGarbage')
          const heap = await cdp.send('Runtime.getHeapUsage')
          const elements = await thinking.locator('*').count()
          const preview = await page.locator('[data-thinking-preview]').filter({ visible: true }).textContent()
          expect(Array.from(preview ?? '').length).toBeLessThanOrEqual(161)
          measurements.push({ stage, characters: 48640 * stage, elements, heapBytes: heap.usedSize - baseline.usedSize })
          console.log(JSON.stringify(measurements.at(-1)))
          await releaseDelayedRequest(request, marker)
        }
        await expect(page.getByText('Thinking stress complete.', { exact: true }).filter({ visible: true })).toBeVisible()
        await writeFile(testInfo.outputPath('thinking-memory.json'), JSON.stringify(measurements, null, 2))
        await testInfo.attach('thinking-memory', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' })
        expect(measurements.at(-1)!.heapBytes).toBeLessThan(32 * 1024 * 1024)
        expect(Math.max(...measurements.map(value => value.elements))).toBeLessThan(2000)
      } finally {
        for (let stage = 1; stage <= 3; stage += 1) await releaseDelayedRequest(request, `E2E_THINKING_STAGE_${stage}`)
        await cdp.detach()
      }
    })
  }
}

test('thinking expansion preference is saved from appearance settings', async ({ page, request }, testInfo) => {
  test.setTimeout(60_000)
  await createAndOpenBook(request, 'Thinking preference')
  await page.goto('/')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const preference = page.getByRole('combobox', { name: '自动展开思考内容', exact: true })
  await expect(preference).toBeVisible()
  for (const enabled of [true, false]) {
    await preference.click()
    await page.getByRole('option', { name: enabled ? '开启' : '关闭', exact: true }).click()
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).user.auto_expand_thinking).toBe(enabled)
    await expect(page.getByText('所有更改均已保存', { exact: true })).toBeVisible()
    await page.reload()
    await expect(preference).toHaveText(enabled ? '开启' : '关闭', { timeout: 30_000 })
  }
  await page.screenshot({ path: testInfo.outputPath('thinking-expansion-setting.png'), animations: 'disabled' })
  await page.setViewportSize({ width: 768, height: 900 })
  await expect(preference).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('thinking-expansion-setting-narrow.png'), animations: 'disabled' })
})
