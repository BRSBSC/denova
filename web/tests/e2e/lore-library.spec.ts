import { expect, test, type APIRequestContext, type Page } from '../support/fixtures'
import { createAndOpenBook } from '../support/api'
import type { LoreItem } from '../../src/lib/api'
import { createRequire } from 'node:module'

const portrait = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
)
const itemsURL = (project: string) => `/api/projects/${project}/book/lore/items`
const readItems = async (request: APIRequestContext, project: string): Promise<LoreItem[]> =>
  (await (await request.get(itemsURL(project))).json()).items
async function seed(request: APIRequestContext, project: string, id: string, type = 'character') {
  const response = await request.post(itemsURL(project), {
    data: {
      id,
      name: `${id} · 资料`,
      type,
      content: `Body of ${id}`,
      brief_description: '简介与长文本 '.repeat(30),
      enabled: true,
    },
  })
  expect(response.ok(), await response.text()).toBe(true)
}
async function openLibrary(page: Page) {
  await page.goto('/')
  await page.getByLabel('工作台侧边栏').getByRole('button', { name: '资料库', exact: true }).click()
  await expect(page.getByTestId('lore-library')).toBeVisible()
}
async function customGenerate(page: Page, title: string) {
  const dialog = page.getByRole('dialog', { name: title, exact: true })
  await dialog.getByLabel('提示词编写方式', { exact: true }).click()
  await page.getByRole('option', { name: '自定义最终提示词', exact: true }).click()
  await dialog
    .getByLabel('最终提示词', { exact: true })
    .fill('Draw a watercolor portrait, soft light, no text.')
  await dialog.getByRole('button', { name: '生成图片', exact: true }).click()
  await expect(dialog).toBeHidden()
}

for (const theme of ['dark', 'light']) {
  test(`browses categorized cards, filters and returns from editing in ${theme}`, async ({
    page,
    request,
  }, testInfo) => {
    const book = await createAndOpenBook(request, `Lore library ${theme}`)
    const settings = await (await request.get('/api/settings')).json()
    await request.patch('/api/settings', {
      data: {
        layer: 'user',
        base_revision: settings.revisions.user,
        changes: { theme, language: 'zh-CN' },
      },
    })
    await openLibrary(page)
    const library = page.getByTestId('lore-library')
    await expect(library.getByText('还没有资料', { exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`library-${theme}-empty.png`) })
    for (const [id, type] of [
      ['hero', 'character'],
      ['friend', 'character'],
      ['city', 'location'],
      ['guild', 'faction'],
      ['rules', 'rule'],
    ])
      await seed(request, book.projectId, id, type)
    const longName = '很长的资料名称LongUnbrokenCharacterName'.repeat(4)
    const friend = (await readItems(request, book.projectId)).find(item => item.id === 'friend')!
    const renamed = await request.put(`${itemsURL(book.projectId)}/friend`, {
      data: { ...friend, name: longName },
    })
    expect(renamed.ok(), await renamed.text()).toBe(true)
    const sharp = createRequire(import.meta.url)('sharp') as typeof import('sharp').default
    for (const [id, width, height] of [['hero', 120, 240], ['city', 320, 120]] as const) {
      const image = await sharp({
        create: { width, height, channels: 3, background: '#a0b8c0' },
      }).png().toBuffer()
      const response = await request.post(`${itemsURL(book.projectId)}/${id}/materials/upload`, {
        multipart: { file: { name: `${id}.png`, mimeType: 'image/png', buffer: image } },
      })
      expect(response.ok(), await response.text()).toBe(true)
      const item = (await readItems(request, book.projectId)).find(item => item.id === id)!
      const cover = await request.post(`${itemsURL(book.projectId)}/${id}/materials`, {
        data: { op: 'cover', asset_id: item.resolved_materials![0].id },
      })
      expect(cover.ok(), await cover.text()).toBe(true)
    }
    await page.reload()
    const hero = library.getByTestId('lore-card-hero')
    const sizes = library.getByRole('group', { name: '卡片大小', exact: true })
    await expect(hero).toBeVisible()
    await expect(library.getByRole('button', { name: longName, exact: true })).toBeVisible()
    await expect(sizes.getByRole('radio', { name: '中', exact: true })).toBeChecked()
    await page.setViewportSize({ width: 1600, height: 1000 })
    const widths: number[] = []
    for (const size of ['小', '中', '大']) {
      await sizes.getByRole('radio', { name: size, exact: true }).click()
      widths.push(await hero.evaluate(element => element.getBoundingClientRect().width))
      for (const id of ['hero', 'city']) {
        const image = library.getByTestId(`lore-card-${id}`).getByRole('img')
        await expect(image).toHaveCSS('object-fit', 'contain')
        await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
      }
      await expect(hero.locator('[data-slot=card-description]')).toHaveCount(size === '小' ? 0 : 1)
      const upload = hero.getByRole('button', { name: '上传封面', exact: true })
      const generate = hero.getByRole('button', { name: '重新生成', exact: true })
      await expect(upload).toBeVisible()
      await expect(generate).toBeVisible()
      await expect(upload).toHaveText('')
      await expect(generate).toHaveText('')
      await expect(upload).toHaveAttribute('title', '上传封面')
      await expect(generate).toHaveAttribute('title', '重新生成')
      await page.screenshot({ path: testInfo.outputPath(`library-${theme}-${size}-wide.png`), animations: 'disabled' })
    }
    expect(widths[0]).toBeLessThan(widths[1])
    expect(widths[1]).toBeLessThan(widths[2])
    await library.getByRole('button', { name: '批量操作', exact: true }).click()
    const checkbox = hero.getByRole('checkbox')
    await checkbox.check()
    await expect(library.getByRole('status')).toHaveText('已选 1 项')
    await checkbox.press('Space')
    await expect(checkbox).not.toBeChecked()
    await hero.getByRole('img').click()
    await expect(checkbox).toBeChecked()
    await expect(hero.locator('[data-slot=card-header]').getByRole('checkbox')).toBeVisible()
    await sizes.getByRole('radio', { name: '小', exact: true }).click()
    await expect(checkbox).toBeChecked()
    await page.screenshot({ path: testInfo.outputPath(`library-${theme}-selection.png`), animations: 'disabled' })
    await library.getByRole('button', { name: '全选当前结果', exact: true }).click()
    await expect(library.getByRole('status')).toHaveText('已选 5 项')
    await library.getByRole('combobox', { name: '资料分类' }).click()
    await page.getByRole('option', { name: '地点', exact: true }).click()
    await expect(library.getByRole('status')).toHaveText('已选 0 项')
    await expect(library.getByTestId('lore-card-hero')).toHaveCount(0)
    await library.getByRole('button', { name: '退出多选', exact: true }).click()
    await library.getByRole('button', { name: 'city · 资料', exact: true }).click()
    await expect(page.getByLabel('名称', { exact: true })).toHaveValue('city · 资料')
    await page.getByRole('button', { name: '返回资料总览', exact: true }).click()
    await expect(library.getByRole('combobox', { name: '资料分类' })).toHaveText('地点')
    await library.getByPlaceholder('搜索名称、简介、标签或正文…').fill('missing')
    await expect(library.getByText('没有匹配的资料', { exact: true })).toBeVisible()
    await library.getByRole('button', { name: '清除筛选', exact: true }).click()
    await expect(library.getByTestId('lore-card-hero')).toBeVisible()
    await page.setViewportSize({ width: 390, height: 844 })
    for (const size of ['小', '中', '大']) {
      await sizes.getByRole('radio', { name: size, exact: true }).click()
      const material = await hero.getByRole('button', { name: '选择封面：hero · 资料', exact: true }).boundingBox()
      const upload = await hero.getByRole('button', { name: '上传封面', exact: true }).boundingBox()
      const generate = await hero.getByRole('button', { name: '重新生成', exact: true }).boundingBox()
      expect(material).not.toBeNull()
      expect(upload).not.toBeNull()
      expect(generate).not.toBeNull()
      expect(Math.abs(material!.y + material!.height / 2 - upload!.y - upload!.height / 2)).toBeLessThan(2)
      expect(Math.abs(upload!.y - generate!.y)).toBeLessThan(2)
      expect(material!.x + material!.width).toBeLessThanOrEqual(upload!.x)
      expect(upload!.x + upload!.width).toBeLessThanOrEqual(generate!.x)
      await page.screenshot({ path: testInfo.outputPath(`library-${theme}-${size}-390.png`), animations: 'disabled' })
      expect(await library.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    }
    expect(await library.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    )
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.reload()
    await expect(sizes.getByRole('radio', { name: '大', exact: true })).toBeChecked()
    await page.setViewportSize({ width: 1600, height: 1000 })
    const sidebar = page.getByLabel('工作台侧边栏')
    for (const surface of ['写作', '游戏']) {
      await sidebar.getByRole('button', { name: surface, exact: true }).click()
      await sidebar.getByRole('button', { name: '资料库', exact: true }).click()
      await expect(sizes.getByRole('radio', { name: '大', exact: true })).toBeChecked()
      await expect(hero).toBeVisible()
    }
  })
}

test('uploads and regenerates covers while keeping old images and text', async ({
  page,
  request,
}, testInfo) => {
  const book = await createAndOpenBook(request, 'Lore cover history')
  await seed(request, book.projectId, 'hero')
  await openLibrary(page)
  const card = page.getByTestId('lore-card-hero')
  await card.getByRole('button', { name: '生成封面', exact: true }).click()
  await customGenerate(page, '生成封面')
  const picker = page.getByRole('dialog', { name: 'hero · 资料 · 封面', exact: true })
  await expect(picker).toBeVisible()
  let item = (await readItems(request, book.projectId))[0]
  expect(item.materials?.cover_asset_id).toBe(item.resolved_materials?.[0].id)
  const original = item.image?.image_path
  await picker
    .locator('[data-slot=dialog-footer]')
    .getByRole('button', { name: '关闭', exact: true })
    .click()
  const sizes = page.getByRole('group', { name: '卡片大小', exact: true })
  await sizes.getByRole('radio', { name: '大', exact: true }).click()
  await card.getByRole('button', { name: '重新生成', exact: true }).click()
  await customGenerate(page, '重新生成')
  await expect(picker).toBeVisible()
  item = (await readItems(request, book.projectId))[0]
  expect(item.image?.image_path).toBe(original)
  expect(item.resolved_materials).toHaveLength(2)
  await picker.getByRole('button', { name: '设为封面', exact: true }).click()
  await expect(picker).toBeHidden()
  await sizes.getByRole('radio', { name: '小', exact: true }).click()
  await card.getByRole('button', { name: '上传封面', exact: true }).click()
  await picker
    .getByLabel('上传封面', { exact: true })
    .setInputFiles({ name: 'portrait.png', mimeType: 'image/png', buffer: portrait })
  await expect
    .poll(async () => (await readItems(request, book.projectId))[0].resolved_materials?.length)
    .toBe(3)
  await expect(
    picker.locator('[data-slot=dialog-footer]').getByRole('button', { name: '关闭', exact: true }),
  ).toBeEnabled()
  item = (await readItems(request, book.projectId))[0]
  expect(item.materials?.cover_asset_id).toBe(item.resolved_materials?.[2].id)
  expect(item.content).toBe('Body of hero')
  expect(item.resolved_materials?.[0].path).toBe(original)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({
    path: testInfo.outputPath('cover-picker-390.png'),
    animations: 'disabled',
  })
  expect(await picker.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  await picker
    .locator('[data-slot=dialog-footer]')
    .getByRole('button', { name: '关闭', exact: true })
    .click()
  await page.reload()
  await expect(card.getByRole('img', { name: 'hero · 资料' })).toBeVisible()
})

test('toggles Lore enabled state from cards and preserves it when saving fails', async ({
  page,
  request,
  browserDiagnostics,
}) => {
  const book = await createAndOpenBook(request, 'Lore card enabled state')
  await seed(request, book.projectId, 'hero')
  await openLibrary(page)
  const card = page.getByTestId('lore-card-hero')
  const toggle = card.getByRole('switch', { name: '启用资料：hero · 资料', exact: true })
  const generate = card.getByRole('button', { name: '生成封面', exact: true })
  await expect(toggle).toBeChecked()
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  await expect(generate).toBeDisabled()
  await expect(card).toBeVisible()
  expect((await readItems(request, book.projectId))[0]).toMatchObject({
    enabled: false,
    name: 'hero · 资料',
    content: 'Body of hero',
  })
  await page.reload()
  await expect(toggle).not.toBeChecked()
  await page.getByRole('group', { name: '卡片大小', exact: true })
    .getByRole('radio', { name: '小', exact: true }).click()
  await toggle.press('Space')
  await expect(toggle).toBeChecked()
  await expect(toggle).toBeEnabled()
  await expect(generate).toBeEnabled()
  expect((await readItems(request, book.projectId))[0].enabled).toBe(true)

  browserDiagnostics.allow(/console\.error: Failed to load resource:.*500/)
  browserDiagnostics.allow(/console\.error: \[lore-card\] enabled state update failed/)
  browserDiagnostics.allow(/http\.5xx: PUT .*\/book\/lore\/items\/hero returned 500/)
  let releaseUpdate!: () => void
  const updateGate = new Promise<void>((resolve) => { releaseUpdate = resolve })
  await page.route(`**${itemsURL(book.projectId)}/hero`, async (route) => {
    if (route.request().method() !== 'PUT') return route.continue()
    await updateGate
    await route.fulfill({ status: 500, json: { error: 'Save unavailable' } })
  })
  await toggle.click()
  try {
    await expect(toggle).toBeDisabled()
  } finally {
    releaseUpdate()
  }
  await expect(page.getByText('启用状态未能保存，请刷新后重试', { exact: true })).toBeVisible()
  await expect(toggle).toBeEnabled()
  await expect(toggle).toBeChecked()
  expect((await readItems(request, book.projectId))[0].enabled).toBe(true)
})

test('batch deletion requires a recovery point and preserves partial failures and shared images', async ({
  page,
  request,
  browserDiagnostics,
}) => {
  const book = await createAndOpenBook(request, 'Lore recoverable deletion')
  for (const id of ['a', 'b']) await seed(request, book.projectId, id)
  const uploaded = await request.post(`${itemsURL(book.projectId)}/a/materials/upload`, {
    multipart: { file: { name: 'portrait.png', mimeType: 'image/png', buffer: portrait } },
  })
  expect(uploaded.ok(), await uploaded.text()).toBe(true)
  const asset = (await readItems(request, book.projectId))[0].resolved_materials![0]
  await request.post(`${itemsURL(book.projectId)}/b/materials`, {
    data: { op: 'link', asset_id: asset.id },
  })
  await openLibrary(page)
  const library = page.getByTestId('lore-library')
  await library.getByRole('button', { name: '批量操作', exact: true }).click()
  await library.getByRole('button', { name: '全选当前结果', exact: true }).click()
  browserDiagnostics.allow(/console\.error: Failed to load resource:.*409/)
  browserDiagnostics.allow(/console\.error: \[lore-library\] deletion failed/)
  const versionsURL = `/api/projects/${book.projectId}/versions`
  await page.route(`**${versionsURL}`, (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 409, json: { error: 'Recovery unavailable' } })
      : route.continue(),
  )
  await library.getByRole('button', { name: '删除', exact: true }).click()
  const dialog = page.getByRole('alertdialog')
  await dialog.getByRole('button', { name: '删除', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('Recovery unavailable')
  expect(await readItems(request, book.projectId)).toHaveLength(2)
  await page.unroute(`**${versionsURL}`)
  await page.route(`**${itemsURL(book.projectId)}/b`, (route) =>
    route.request().method() === 'DELETE'
      ? route.fulfill({ status: 409, json: { error: 'Try again' } })
      : route.continue(),
  )
  await dialog.getByRole('button', { name: '删除', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(library.getByRole('status')).toHaveText('已选 1 项')
  await expect(library.getByTestId('lore-card-a')).toHaveCount(0)
  expect((await readItems(request, book.projectId)).map((item) => item.id)).toEqual(['b'])
  const media = await request.get(
    `/api/projects/${book.projectId}/files/asset?path=${encodeURIComponent(asset.path)}`,
  )
  expect(media.ok()).toBe(true)
  const versions = (await (await request.get(versionsURL)).json()).versions
  const recovery = versions.find(
    (version: { message: string }) => version.message === '批量删除资料前的恢复点',
  )
  expect(recovery).toBeTruthy()
  const restored = await request.post(`${versionsURL}/${recovery.id}/restore`, {
    data: { paths: ['setting/lore/items.json'] },
  })
  expect(restored.ok(), await restored.text()).toBe(true)
  expect(await readItems(request, book.projectId)).toHaveLength(2)
})

test('batch generation fills missing covers or appends images through the existing Agent', async ({
  page,
  request,
}) => {
  const book = await createAndOpenBook(request, 'Lore batch generation')
  for (const id of ['a', 'b']) await seed(request, book.projectId, id)
  await request.post(`${itemsURL(book.projectId)}/a/materials/upload`, {
    multipart: { file: { name: 'portrait.png', mimeType: 'image/png', buffer: portrait } },
  })
  let items = await readItems(request, book.projectId)
  await request.post(`${itemsURL(book.projectId)}/a/materials`, {
    data: { op: 'cover', asset_id: items[0].resolved_materials![0].id },
  })
  items = await readItems(request, book.projectId)
  const existing = items[0].image
  await openLibrary(page)
  const library = page.getByTestId('lore-library')
  await library.getByRole('button', { name: '批量操作', exact: true }).click()
  await library.getByRole('button', { name: '全选当前结果', exact: true }).click()
  await library.getByRole('button', { name: '生成图片', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '批量生成 · 2 项', exact: true })
  await dialog.locator('textarea').fill('E2E_LORE_BATCH')
  await dialog.getByRole('button', { name: '生成图片', exact: true }).click()
  await expect
    .poll(
      async () => (await readItems(request, book.projectId)).find((item) => item.id === 'b')?.image,
      { timeout: 60000 },
    )
    .toBeTruthy()
  items = await readItems(request, book.projectId)
  expect(items[0].image).toEqual(existing)
  expect(items[0].resolved_materials).toHaveLength(1)
  expect(items[1].resolved_materials).toHaveLength(1)
  expect(items.map((item) => item.content)).toEqual(['Body of a', 'Body of b'])
  const covers = items.map((item) => item.image)
  await expect(page.getByText('E2E Lore batch completed.', { exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: '配置管理', exact: true }).click()
  await library.getByRole('button', { name: '生成图片', exact: true }).click()
  await dialog.getByRole('radio', { name: '每项追加一张', exact: true }).click()
  await dialog.locator('textarea').fill('E2E_LORE_BATCH_ADDITIONAL')
  await dialog.getByRole('button', { name: '生成图片', exact: true }).click()
  await expect
    .poll(
      async () =>
        (await readItems(request, book.projectId)).map((item) => item.resolved_materials?.length),
      { timeout: 60000 },
    )
    .toEqual([2, 2])
  expect((await readItems(request, book.projectId)).map((item) => item.image)).toEqual(covers)
})
