import { mkdtemp } from 'node:fs/promises'
import path from 'node:path'
import { runtimeRoot } from '../../scripts/e2e-paths.mjs'
import { expect, test } from '../support/fixtures'
import { createAgentChatSession, createAndOpenBook, registerAgentChatProject } from '../support/api'
import { openAgentChatSession, openAgentChatWorkbench, openWritingAgent } from '../support/agent-chat'

for (const product of ['writing', 'general'] as const) {
  for (const theme of ['dark', 'light'] as const) {
    test(`${product} manual compaction shows progress, failure and retry in ${theme}`, async ({ page, request, browserDiagnostics }, testInfo) => {
      test.setTimeout(60_000)
      browserDiagnostics.allow(/console\.error:.*slash command failed/)
      browserDiagnostics.allow(/console\.error: Failed to load resource:.*400/)
      let projectId: string
      if (product === 'writing') {
        projectId = (await createAndOpenBook(request, 'Compaction feedback')).projectId
      } else {
        const directory = await mkdtemp(path.join(runtimeRoot, 'compaction-feedback-'))
        projectId = (await registerAgentChatProject(request, directory)).id
        await createAgentChatSession(request, projectId, 'Compaction feedback')
      }
      const settings = await (await request.get('/api/settings')).json()
      await page.route(/\/api\/(?:projects\/[^/]+\/)?settings$/, route => route.fulfill({ json: {
        ...settings, effective: { ...settings.effective, theme, language: 'zh-CN' },
      } }))
      let finish!: () => void
      const firstResponse = new Promise<void>((resolve) => { finish = resolve })
      let attempts = 0
      await page.route(/\/api\/(?:.*\/)?command$/, async route => {
        expect(route.request().postDataJSON().command).toBe('compact')
        attempts += 1
        if (attempts === 1) {
          await firstResponse
          await route.fulfill({ status: 400, json: {
            error: '测试压缩失败，请重试。', code: 'agent_runtime.command_failed', request_id: 'compact-feedback-failure',
          } })
        } else await route.fulfill({ json: { result: '上下文压缩完成：12000 tokens → 2000 tokens。' } })
      })
      await page.setViewportSize({ width: 1440, height: 960 })
      await page.goto('/')
      if (product === 'writing') await openWritingAgent(page)
      else {
        await openAgentChatWorkbench(page)
        await openAgentChatSession(page, projectId, 'Compaction feedback')
      }
      const composer = page.getByPlaceholder(/输入消息/).filter({ visible: true })
      const send = page.locator('[data-action="send"]').filter({ visible: true })
      await composer.fill('/compact')
      await send.click()
      await expect(page.getByText('正在压缩会话上下文，完成后可继续发送消息。', { exact: true })).toBeVisible()
      await composer.fill('/compact')
      await expect(send).toBeDisabled()
      await composer.press('Enter')
      expect(attempts).toBe(1)
      await page.screenshot({ path: testInfo.outputPath(`${product}-${theme}-compacting.png`), animations: 'disabled' })
      if (product === 'writing') {
        await page.setViewportSize({ width: 390, height: 844 })
        // Click waits for the narrow layout to render its tabs. A count() check
        // can run first, skip the click and leave the Agent panel hidden.
        await page.getByRole('tab', { name: 'Agent', exact: true }).click()
        await expect(page.getByText('正在压缩会话上下文，完成后可继续发送消息。', { exact: true })).toBeVisible()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      }
      finish()
      await expect(page.getByText(/测试压缩失败，请重试。/).filter({ visible: true }).first()).toBeVisible()
      await expect(send).toBeEnabled()
      await expect(page.locator('[data-sonner-toast][data-type=error]')).toHaveCount(0)
      await expect(composer).toHaveText('/compact')
      await page.screenshot({ path: testInfo.outputPath(`${product}-${theme}-failed.png`), animations: 'disabled' })
      await send.click()
      await expect(page.getByText('上下文压缩完成：12000 tokens → 2000 tokens。', { exact: true })).toBeVisible()
      await expect(page.getByText('正在压缩会话上下文，完成后可继续发送消息。', { exact: true })).toHaveCount(0)
      expect(attempts).toBe(2)
      await composer.fill('Continue after compaction')
      await expect(send).toBeEnabled()
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    })
  }
}