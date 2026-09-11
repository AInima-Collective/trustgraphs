/**
 * Regression checks for mobile reflow, wizard focus and shared controls.
 * Run against a build with NEXT_PUBLIC_TG_REVIEW_FIXTURES=1. All metadata
 * writes are intercepted locally; this script never submits a transaction.
 */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'

import { chromium } from 'playwright'

const origin = process.env.FRONTEND_URL ?? 'http://127.0.0.1:3791'
const network = process.env.FRONTEND_NETWORK_ID ?? 'demo-co-op'
const output =
  process.env.FRONTEND_SMOKE_OUTPUT ?? '.trustgraph/shots/accessibility'
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  viewport: { width: 320, height: 720 },
  isMobile: true,
  hasTouch: true,
  reducedMotion: 'reduce',
})
const page = await context.newPage()
page.setDefaultTimeout(20_000)
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
let releaseMetadata
let metadataRequestCount = 0
let markMetadataRequested
const metadataRequested = new Promise((resolve) => {
  markMetadataRequested = resolve
})

// Hold metadata while checking the busy state, then answer without pinning.
await page.route('**/api/ipfs', async (route) => {
  if (route.request().method() !== 'POST') return route.continue()
  metadataRequestCount += 1
  if (metadataRequestCount === 1) {
    await new Promise((resolve) => {
      releaseMetadata = resolve
      markMetadataRequested()
    })
  }
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      cid: 'bafyreviewfixture',
      uri: 'ipfs://bafyreviewfixture',
    }),
  })
})

const noOverflow = async () => {
  const width = page.viewportSize().width
  const actual = await page.evaluate(() => document.documentElement.scrollWidth)
  // Mobile browsers may expand innerWidth to fit overflow. Compare with the
  // configured viewport, otherwise the regression incorrectly passes.
  assert.ok(
    actual <= width + 1,
    `Document width ${actual} exceeds viewport ${width}`
  )
}
const focused = async (id) => {
  await page.waitForFunction(
    (value) => document.activeElement?.id === value,
    id
  )
}

try {
  await mkdir(output, { recursive: true })
  await page.goto(`${origin}/create/standard`, {
    waitUntil: 'domcontentloaded',
  })
  await page.locator('#network-name').waitFor()
  await page.evaluate(() => document.fonts.ready)
  const fields = await page
    .locator('input:not([type="range"]), textarea')
    .evaluateAll((elements) =>
      elements.map((element) => ({
        id: element.id,
        size: parseFloat(getComputedStyle(element).fontSize),
      }))
    )
  assert.ok(fields.length > 0)
  for (const field of fields)
    assert.ok(
      field.size >= 16,
      `${field.id} has ${field.size}px text on a touch device`
    )
  await noOverflow()

  const continueButton = page.getByRole('button', {
    name: 'Continue',
    exact: true,
  })
  await page.waitForFunction(() =>
    [...document.querySelectorAll('button')].some(
      (button) => button.textContent.trim() === 'Continue' && !button.disabled
    )
  )
  await continueButton.click()
  await focused('network-name')
  assert.equal(
    await page.locator('#network-name').getAttribute('aria-invalid'),
    'true'
  )
  assert.ok(
    await page.locator('#network-name').getAttribute('aria-describedby')
  )
  await page.screenshot({
    path: `${output}/invalid-name-320.png`,
    fullPage: false,
  })

  const draftFields = {
    'network-name': 'Accessibility regression fixture',
    'network-description': 'A local browser regression draft.',
    'network-criteria': 'Vouch after working together.',
    'network-image': 'https://example.com/network.png',
    'network-application': 'https://example.com/join',
  }
  for (const [id, value] of Object.entries(draftFields))
    await page.locator(`#${id}`).fill(value)
  await page.waitForFunction(
    (name) =>
      Object.keys(localStorage).some((key) => {
        if (!key.startsWith('trustgraphs:create:')) return false
        const saved = JSON.parse(localStorage.getItem(key))
        return saved?.value?.data?.name === name
      }),
    draftFields['network-name']
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Restore draft', exact: true }).click()
  // Restoring hands focus to the step heading on the next animation frame.
  // Wait for that handoff before editing: clearing a field is an in-page
  // focus() followed by a separate Delete keypress, and a focus move landing
  // between the two leaves that field, and therefore the draft, intact.
  await page.waitForFunction(
    () =>
      /^H[1-6]$/.test(document.activeElement?.tagName ?? '') &&
      /what is this network/i.test(document.activeElement.textContent)
  )
  for (const [id, value] of Object.entries(draftFields))
    assert.equal(await page.locator(`#${id}`).inputValue(), value)
  assert.equal(metadataRequestCount, 0, 'Restoring does not publish metadata')

  // Erasing the last meaningful field must also erase the stored draft.
  for (const id of Object.keys(draftFields))
    await page.locator(`#${id}`).fill('')
  await page.waitForFunction(() =>
    Object.keys(localStorage).every(
      (key) => !key.startsWith('trustgraphs:create:')
    )
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('#network-name').waitFor()
  await page.waitForFunction(() =>
    [...document.querySelectorAll('button')].some(
      (button) => button.textContent.trim() === 'Continue' && !button.disabled
    )
  )
  assert.equal(
    await page
      .getByRole('button', { name: 'Restore draft', exact: true })
      .count(),
    0
  )
  for (const [id, value] of Object.entries(draftFields)) {
    assert.equal(await page.locator(`#${id}`).inputValue(), '')
    await page.locator(`#${id}`).fill(value)
  }
  await continueButton.click()
  // Some creation flows defer pinning until final review. If the first step
  // pins, test the genuine pending state; otherwise proceed to Starting accounts.
  const startingHeading = page.getByRole('heading', {
    name: 'Who does your community already trust?',
  })
  const didPin = await Promise.race([
    metadataRequested.then(() => true),
    startingHeading.waitFor().then(() => false),
  ])
  if (didPin) {
    await noOverflow()
    await page.screenshot({ path: `${output}/saving-320.png`, fullPage: false })
    releaseMetadata()
  }
  await startingHeading.waitFor()
  assert.equal(metadataRequestCount, 1, 'Continue saves metadata exactly once')
  await page.waitForFunction(
    () =>
      /^H[1-6]$/.test(document.activeElement.tagName) &&
      /community already trust/i.test(document.activeElement.textContent)
  )
  const stepFocus = await page.evaluate(() => ({
    tag: document.activeElement.tagName,
    text: document.activeElement.textContent,
  }))
  assert.match(stepFocus.tag, /^H[1-6]$/)
  assert.match(stepFocus.text, /community already trust/i)

  await page
    .getByRole('button', { name: 'Add my account', exact: true })
    .click()
  await continueButton.click()
  await page
    .getByRole('heading', { name: 'Set up scoring', exact: true })
    .waitFor()
  await page
    .getByRole('button', { name: 'Advanced settings', exact: true })
    .click()
  await noOverflow()
  await page.screenshot({ path: `${output}/scoring-320.png`, fullPage: true })
  await continueButton.click()
  const fund = page.getByRole('switch', {
    name: 'Add a shared fund',
    exact: true,
  })
  await fund.waitFor()
  const beforeFund = await fund.getAttribute('aria-checked')
  await fund.focus()
  await page.keyboard.press('Space')
  assert.notEqual(await fund.getAttribute('aria-checked'), beforeFund)
  const fundRect = await fund.boundingBox()
  assert.ok(fundRect.width >= 44 && fundRect.height >= 44)

  await page.goto(`${origin}/networks/${network}`, {
    waitUntil: 'domcontentloaded',
  })
  const members = page.getByRole('region', {
    name: 'Network members and scores',
  })
  const firstMember = members.locator('li').first()
  await firstMember.waitFor()
  const memberBounds = await firstMember.boundingBox()
  const scoreBounds = await firstMember.locator('.text-right').boundingBox()
  assert.ok(memberBounds.x >= 0 && memberBounds.x + memberBounds.width <= 321)
  assert.ok(
    scoreBounds.x >= 0 && scoreBounds.x + scoreBounds.width <= 321,
    'Member score stays visible on a phone'
  )
  await noOverflow()
  const graphGuide = page.locator('details').filter({
    has: page.locator('summary', { hasText: 'How to read the graph' }),
  })
  await graphGuide.waitFor()
  assert.equal(await graphGuide.getAttribute('open'), null)
  const guideSummary = graphGuide.locator('summary')
  await guideSummary.focus()
  await page.keyboard.press('Enter')
  assert.equal(await graphGuide.getAttribute('open'), '')
  await page.keyboard.press('Enter')
  await page.screenshot({ path: `${output}/members-320.png`, fullPage: true })
  await page.setViewportSize({ width: 844, height: 390 })
  const simulate = page.getByRole('button', { name: /^simulate$/i })
  await simulate.waitFor()
  await simulate.click()
  const dialog = page.getByRole('dialog', {
    name: 'Simulate scores',
    exact: true,
  })
  await dialog.waitFor()
  // Opening a popup transfers focus on the next animation frame. Wait for
  // that handoff before requesting a later field, so it cannot undo our scroll.
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute('role') === 'switch' &&
      document.activeElement?.getAttribute('aria-label') === 'Simulate scores'
  )
  await page.waitForFunction(() => {
    const panel = document.querySelector(
      '[role="dialog"][aria-label="Simulate scores"]'
    )
    return (
      panel && panel.style.maxHeight && panel.getBoundingClientRect().height > 0
    )
  })
  const bounds = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return {
      top: rect.top,
      bottom: rect.bottom,
      overflow: getComputedStyle(element).overflowY,
    }
  })
  assert.ok(
    bounds.top >= 0 && bounds.bottom <= 390,
    `Popup outside viewport: ${JSON.stringify(bounds)}`
  )
  assert.equal(bounds.overflow, 'auto')
  const lastField = dialog.getByRole('spinbutton', {
    name: 'Maximum iterations',
  })
  await lastField.focus()
  await page.evaluate(() => new Promise(requestAnimationFrame))
  const focusedBounds = await lastField.evaluate((input) => {
    const field = input.getBoundingClientRect()
    const panel = input.closest('[role="dialog"]').getBoundingClientRect()
    return {
      fieldTop: field.top,
      fieldBottom: field.bottom,
      panelTop: panel.top,
      panelBottom: panel.bottom,
    }
  })
  assert.ok(
    focusedBounds.fieldTop >= focusedBounds.panelTop &&
      focusedBounds.fieldBottom <= focusedBounds.panelBottom + 1 &&
      focusedBounds.panelTop >= 0 &&
      focusedBounds.panelBottom <= 390,
    `Focused field must remain inside the popup and viewport: ${JSON.stringify(focusedBounds)}`
  )
  await lastField.fill('101')
  await page.screenshot({
    path: `${output}/simulation-landscape.png`,
    fullPage: false,
  })
  await page.keyboard.press('Escape')
  assert.equal(await simulate.getAttribute('aria-expanded'), 'false')
  assert.equal(
    await simulate.evaluate((element) => element === document.activeElement),
    true
  )

  const rank = page.getByRole('button', { name: /^rank$/i }).first()
  const rankHeader = rank.locator('..').locator('..')
  const beforeSort = await rankHeader.getAttribute('aria-sort')
  await rank.focus()
  await page.keyboard.press('Space')
  assert.notEqual(await rankHeader.getAttribute('aria-sort'), beforeSort)
  assert.equal(
    await page.locator('a button, button button, button a').count(),
    0
  )
  await noOverflow()

  await page.goto(`${origin}/attestations`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('combobox', { name: /^verification status$/i }).waitFor()
  await page.getByRole('combobox', { name: /^sort order$/i }).waitFor()

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${origin}/create/weighted`, {
    // This form is server-rendered. Let its client handlers hydrate before
    // typing; the fixture APIs settle immediately and have no persistent streams.
    waitUntil: 'networkidle',
  })
  const weightedName = page.locator('#weighted-name')
  const createName = 'Create mode draft'
  const copiedName = 'Copied accounts draft'
  const weightedSource =
    'account,weight\n0x1000000000000000000000000000000000000001,1'
  await weightedName.fill(createName)
  await page.locator('#prior-source').fill(weightedSource)
  const waitWeightedDraft = async (mode, name) =>
    page.waitForFunction(
      ({ mode, name }) =>
        Object.keys(localStorage).some(
          (key) =>
            key.startsWith('trustgraphs:creation:weighted:') &&
            key.endsWith(`:${mode}`) &&
            JSON.parse(localStorage.getItem(key))?.value?.name === name
        ),
      { mode, name }
    )
  await waitWeightedDraft('create', createName)
  await page
    .getByRole('button', { name: 'Copy starting accounts', exact: true })
    .click()
  assert.equal(
    await weightedName.inputValue(),
    '',
    'A different mode starts with its own fields'
  )
  await weightedName.fill(copiedName)
  await waitWeightedDraft('redeploy', copiedName)
  await page
    .getByRole('button', { name: 'Enter starting shares', exact: true })
    .click()
  await page.getByRole('button', { name: 'Restore draft', exact: true }).click()
  assert.equal(await weightedName.inputValue(), createName)
  assert.equal(await page.locator('#prior-source').inputValue(), weightedSource)
  await page
    .getByRole('button', { name: 'Copy starting accounts', exact: true })
    .click()
  await page.getByRole('button', { name: 'Restore draft', exact: true }).click()
  assert.equal(await weightedName.inputValue(), copiedName)
  await noOverflow()

  const fallbackContext = await browser.newContext({
    viewport: { width: 320, height: 720 },
    isMobile: true,
    hasTouch: true,
  })
  await fallbackContext.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      if (['webgl', 'webgl2', 'experimental-webgl'].includes(type)) return null
      return getContext.call(this, type, ...args)
    }
  })
  const fallbackPage = await fallbackContext.newPage()
  fallbackPage.on('pageerror', (error) => errors.push(error.message))
  await fallbackPage.goto(`${origin}/networks/${network}`, {
    waitUntil: 'domcontentloaded',
  })
  await fallbackPage
    .getByText('The graph is unavailable in this browser.', { exact: true })
    .waitFor()
  await fallbackPage
    .getByRole('region', { name: 'Network members and scores' })
    .locator('li')
    .first()
    .waitFor()
  assert.ok(
    await fallbackPage
      .getByRole('link', { name: 'View members and scores', exact: true })
      .getAttribute('href')
  )
  assert.ok(
    await fallbackPage.evaluate(
      () => document.documentElement.scrollWidth <= 321
    )
  )
  await fallbackPage.screenshot({
    path: `${output}/no-webgl-320.png`,
    fullPage: true,
  })
  await fallbackContext.close()
  const staticContext = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 320, height: 720 },
  })
  const staticPage = await staticContext.newPage()
  await staticPage.goto(origin, { waitUntil: 'domcontentloaded' })
  assert.equal(
    await staticPage
      .getByRole('link', { name: /browse networks/i })
      .getAttribute('href'),
    '/networks'
  )
  await staticContext.close()
  assert.deepEqual(
    errors,
    [],
    'No browser runtime errors during regression checks'
  )
  console.log(
    'frontend accessibility smoke: mobile input sizing/reflow, draft restore/clear/mode scopes, validation/step focus, switches, graph guide/WebGL fallback, popup scrolling, keyboard sorting and filter labels passed'
  )
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png`, fullPage: true })
  console.error('Browser runtime errors:', errors)
  console.error('Failed at:', page.url())
  throw error
} finally {
  releaseMetadata?.()
  await browser.close()
}
