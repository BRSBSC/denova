import { expect, test } from '../support/fixtures'
import { createAndOpenBook, createStartedStory, getStorySnapshot } from '../support/api'

test('reveals the Game timeline only after its tail row is rendered and positioned', async ({ page, request }) => {
  await createAndOpenBook(request, 'Game initial position')
  const story = await createStartedStory(request, 'Initial position')
  const turn = (await getStorySnapshot(request, story.id)).turns[0]
  const edited = await request.patch(`/api/interactive/stories/${story.id}/turns/${turn.id}/narrative`, {
    data: { branch_id: 'main', expected_narrative: turn.narrative, narrative: '车站的灯光照亮漫长的轨道，旅人沿着脚印继续探索。'.repeat(180) },
  })
  expect(edited.ok(), await edited.text()).toBe(true)
  // Virtuoso mounts its rows several frames after the list. Stretch the app's
  // frames so that gap spans many real ones, and sample the timeline on each.
  await page.addInitScript(() => {
    const nextFrame = window.requestAnimationFrame.bind(window)
    window.requestAnimationFrame = callback => window.setTimeout(() => callback(performance.now()), 80)
    window.cancelAnimationFrame = handle => window.clearTimeout(handle)
    const frames: Array<{ busy: string | null; rows: number; tail: boolean; hidden: boolean; scrollTop: number; scrollHeight: number }> = []
    Object.assign(window, { __timelineFrames: frames })
    const sample = () => {
      const timeline = document.querySelector('.nova-story-stage-content .nova-chat-canvas')
      const list = timeline?.querySelector<HTMLElement>('[data-testid="virtuoso-item-list"]')
      if (timeline && frames.length < 2000) frames.push({
        busy: timeline.getAttribute('aria-busy'),
        rows: timeline.querySelectorAll('[data-nova-chat-row-key]').length,
        tail: Boolean(timeline.querySelector('[data-nova-chat-tail-row]')),
        hidden: !list || list.style.visibility === 'hidden',
        scrollTop: timeline.scrollTop,
        scrollHeight: timeline.scrollHeight,
      })
      nextFrame(sample)
    }
    nextFrame(sample)
  })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/')
  await page.getByLabel('工作台侧边栏').getByRole('button', { name: '游戏', exact: true }).click()
  const timeline = page.locator('.nova-story-stage-content .nova-chat-canvas')
  await timeline.waitFor({ state: 'attached' })
  // The hidden timeline ignores pointer events; park the cursor without waiting for it.
  const box = (await timeline.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.waitForFunction(() => document.querySelector('.nova-story-stage-content .nova-chat-canvas')?.getAttribute('aria-busy') === 'false')
  await page.mouse.wheel(0, -600)

  const distanceFromBottom = () => timeline.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)
  await expect(timeline.locator('[data-nova-chat-tail-row]')).toBeVisible()
  const frames = await page.evaluate(() => (window as unknown as { __timelineFrames: Array<{ busy: string | null; rows: number; tail: boolean; hidden: boolean; scrollTop: number; scrollHeight: number }> }).__timelineFrames)
  await test.info().attach('timeline-frames', { body: JSON.stringify(frames), contentType: 'application/json' })
  const revealed = frames.filter(frame => frame.busy === 'false')
  expect(revealed.length).toBeGreaterThan(0)
  expect(revealed.filter(frame => !frame.tail || frame.hidden)).toEqual([])
  // Scrolling up right after the reveal must not be swallowed by a late re-pin.
  await expect.poll(distanceFromBottom, { timeout: 5_000 }).toBeGreaterThan(400)
  await page.waitForTimeout(1_000)
  expect(await distanceFromBottom()).toBeGreaterThan(400)
})
