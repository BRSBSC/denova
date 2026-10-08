import { expect, test } from '../support/fixtures'

for (const theme of ['dark', 'light']) {
  test(`market sidebar stays within its pane in ${theme}`, async ({ page, request }) => {
    await request.patch('/api/settings', {
      data: { layer: 'user', changes: { language: 'en-US', theme } },
    })
    await page.addInitScript(() => {
      localStorage.setItem('nova:mode', 'market')
      localStorage.setItem('nova.locale.configured', 'en-US')
    })
    await page.route('**/api/resource-market/catalog', route =>
      route.fulfill({ json: { schema_version: 1, entries: [] } }),
    )
    await page.goto('/')
    const navigation = page.getByRole('navigation', { name: 'Market navigation', exact: true })
    for (const width of [1440, 1100, 390]) {
      await page.setViewportSize({ width, height: 600 })
      if (width === 390) {
        await page.getByRole('button', { name: 'Market navigation directory', exact: true }).click()
      }
      await expect(navigation).toBeVisible()
      // Check the actual scroll extents, including inset separators and the footer.
      expect(await navigation.evaluate(element =>
        [element, ...element.querySelectorAll('[data-sidebar="content"]')].every(
          node => node.scrollWidth <= node.clientWidth,
        ),
      )).toBe(true)
      await expect(navigation.getByRole('link', { name: 'Submit a package' })).toBeVisible()
      await page.screenshot({ path: `test-results/market-sidebar-${theme}-${width}.png` })
    }
  })
}
