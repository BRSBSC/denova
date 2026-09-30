import { expect, test } from '../support/fixtures'
import { createAndOpenBook } from '../support/api'

for (const theme of ['dark', 'light']) {
  test(`market updates an existing project and resolves individual conflicts in ${theme}`, async ({ page, request }) => {
    await request.patch('/api/settings', { data: { layer: 'user', changes: { language: 'en-US', theme } } })
    const book = await createAndOpenBook(request, 'Update destination')
    await page.addInitScript(() => { localStorage.setItem('nova:mode', 'market'); localStorage.setItem('nova.locale.configured', 'en-US') })
    const source = { kind: 'github', url: 'https://github.com/author/resources', ref: 'main', path: 'story' }
    const entry = { id: 'story', name: { 'en-US': 'Story resources' }, description: { 'en-US': 'Shared writing and game resources' }, author: 'Author', kinds: ['lore.collection'], tags: ['writing', 'game'], format: 'denova.resource-pack', updated_at: '2026-09-30', source }
    const installation = { installation_id: 'installed', package: { id: 'story', name: 'Story resources' }, source, tracking: 'tracked', update_mode: 'manual', project_id: book.projectId, bindings: [{ resource_id: 'lore', local: { kind: 'lore.collection', scope: 'project', project_id: book.projectId, id: 'local' }, ownership: 'owned', source_digest: 'before' }] }
    const other = { ...installation, installation_id: 'elsewhere', project_id: 'another-project' }
    const preview = { preview_id: 'update-preview', source, candidates: [{ candidate_id: 'candidate', package: installation.package, format: 'denova.resource-pack', resources: [{ id: 'lore', name: 'Characters', kind: 'lore.collection', path: 'lore.json', digest: 'after' }] }] }
    const name = 'CharacterWithAVeryLongNameWhoseLocalAndUpstreamDescriptionsBothChanged'
    let plans = 0, applied = '', checked = ''
    await page.route('**/api/resource-market/catalog', route => route.fulfill({ json: { schema_version: 1, entries: [entry] } }))
    await page.route('**/api/resource-exchange/installations', route => route.fulfill({ json: [other, installation] }))
    await page.route('**/api/resource-exchange/installations/*/check', route => {
      checked = route.request().url()
      return route.fulfill({ json: preview })
    })
    await page.route('**/api/resource-exchange/previews/update-preview', route => route.fulfill({ json: {} }))
    await page.route('**/api/resource-exchange/plans', route => {
      const body = route.request().postDataJSON()
      expect(body.installation_id).toBe('installed')
      expect(body.project_id).toBe(book.projectId)
      const resolution = body.resolutions?.lore?.hero
      plans++
      return route.fulfill({ json: { plan_id: `plan-${plans}`, items: [], installation, updates: [
        { resource_id: 'lore', member_id: 'world', name: 'World setting', state: 'update' },
        { resource_id: 'lore', member_id: 'hero', name, state: resolution === 'keep' ? 'keep' : resolution === 'remote' ? 'update' : 'conflict', conflict: true, resolution },
      ] } })
    })
    await page.route('**/api/resource-exchange/plans/*/apply', route => { applied = route.request().url(); return route.fulfill({ json: installation }) })
    await page.goto('/')
    await page.getByRole('button', { name: 'Story resources', exact: true }).click()
    const detail = page.getByTestId('market-entry-detail')
    await expect(detail.getByRole('combobox', { name: 'Update destination' })).toContainText(book.title)
    await detail.getByRole('button', { name: 'Check and update installed package' }).click()
    expect(checked).toContain('/installed/check')
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Review plan', exact: true }).click()
    await expect(dialog.getByText('Both sides changed', { exact: true })).toBeVisible()
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 })
      await expect.poll(() => dialog.evaluate(element => {
        const bounds = element.getBoundingClientRect()
        return { fits: element.scrollWidth <= element.clientWidth, width: element.clientWidth, scroll: element.scrollWidth, overflow: [...element.querySelectorAll('*')].filter(child => child.getBoundingClientRect().right > bounds.right + 1).map(child => [child.tagName, child.className]) }
      })).toMatchObject({ fits: true, overflow: [] })
      await page.screenshot({ path: `test-results/market-update-${theme}-${width}.png`, fullPage: true })
    }
    const resolution = dialog.getByRole('combobox', { name: `Resolve conflict for ${name}` })
    await resolution.click()
    await page.getByRole('option', { name: 'Keep my content and continue tracking' }).click()
    await expect(resolution).toContainText('Keep my content')
    expect(plans).toBe(2)
    await resolution.click()
    await page.getByRole('option', { name: 'Back up and use upstream content' }).click()
    await expect(resolution).toContainText('Back up and use upstream')
    await dialog.getByRole('button', { name: 'Apply this update', exact: true }).click()
    await expect(dialog).toBeHidden()
    expect(applied).toContain('/plan-3/apply')
  })
}
