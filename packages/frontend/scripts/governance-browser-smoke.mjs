import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let chromium
try {
  ;({ chromium } = require('playwright'))
} catch {
  ;({ chromium } = require('/usr/lib/node_modules/playwright'))
}

const origin = process.env.GOVERNANCE_FRONTEND_URL ?? 'http://127.0.0.1:3789'
const network = process.env.GOVERNANCE_NETWORK_ID ?? 'demo-co-op'
const route = `/networks/${network}/governance`
const output =
  process.env.GOVERNANCE_SMOKE_OUTPUT ?? '.trustgraph/shots/governance'
const reviewFixtures = process.env.FRONTEND_REVIEW_FIXTURES === '1'
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
})
const page = await context.newPage()
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
page.setDefaultTimeout(20_000)

const noOverflow = async () => {
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    ),
    'page must fit the viewport'
  )
}

try {
  await mkdir(output, { recursive: true })
  await page.goto(`${origin}${route}/new`, { waitUntil: 'domcontentloaded' })
  await page
    .getByRole('heading', { name: 'Action library', exact: true })
    .waitFor()
  assert.match(await page.title(), /^Create proposal/)
  await page.screenshot({ path: `${output}/desktop-empty.png`, fullPage: true })
  await noOverflow()
  await page
    .getByRole('button', { name: 'Review proposal', exact: true })
    .click()
  await page.getByText('Give your proposal a title.', { exact: true }).waitFor()
  await page
    .getByLabel('Proposal title', { exact: true })
    .fill('Fund community research')
  await page
    .getByLabel('Description', { exact: true })
    .fill(
      '## Purpose\n\nSupport the next community research round with a treasury grant.'
    )
  await page
    .getByRole('button', { name: 'Review proposal', exact: true })
    .click()
  await page.getByRole('heading', { name: 'Review your proposal.' }).waitFor()
  await page.getByText('Signal vote', { exact: true }).first().waitFor()
  if (reviewFixtures) {
    // The isolated runner uses the existing connected mock wallet. It supplies
    // no voting authority, so the final action must remain unavailable.
    const submit = page.getByRole('button', {
      name: 'Submit proposal',
      exact: true,
    })
    await submit.waitFor()
    assert.equal(await submit.isDisabled(), true)
  } else {
    await page
      .locator('form')
      .getByRole('button', { name: 'Connect wallet', exact: true })
      .waitFor()
    assert.equal(
      await page
        .getByRole('button', { name: 'Submit proposal', exact: true })
        .count(),
      0
    )
  }
  await page.getByRole('button', { name: 'Back', exact: true }).click()

  await page
    .getByRole('searchbox', { name: 'Search actions' })
    .fill('zz-no-matching-action')
  await page.getByText('No matching actions', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click()
  await page.getByRole('button', { name: 'Treasury', exact: true }).click()
  assert.equal(
    await page
      .getByRole('button', { name: 'Treasury', exact: true })
      .getAttribute('aria-pressed'),
    'true'
  )
  await page.getByRole('button', { name: 'Add Send ETH', exact: true }).click()
  await page.getByText('Needs attention', { exact: true }).waitFor()
  await page
    .getByRole('button', { name: 'Review proposal', exact: true })
    .click()
  assert.equal(
    await page.getByRole('heading', { name: 'Review your proposal.' }).count(),
    0
  )
  const recipient = '0x1111111111111111111111111111111111111111'
  await page.getByLabel('Recipient', { exact: true }).fill(recipient)
  await page.getByLabel('Amount', { exact: true }).fill('0.1')
  await page.getByText('1 of 1 ready', { exact: true }).waitFor()

  await page
    .getByRole('button', { name: 'Duplicate action 1', exact: true })
    .click()
  await page.getByText('2 of 2 ready', { exact: true }).waitFor()
  await page
    .locator('[id^="action-editor-"]:visible')
    .getByLabel('Amount', { exact: true })
    .fill('0.2')
  await page.getByText('2 of 2 ready', { exact: true }).waitFor()
  await page
    .getByRole('button', { name: 'Move action 2 up', exact: true })
    .click()
  assert.equal(
    await page
      .locator('article')
      .first()
      .getByLabel('Amount', { exact: true })
      .inputValue(),
    '0.2'
  )
  await page
    .getByRole('button', { name: 'Remove action 1', exact: true })
    .click()
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await page.getByText('2 of 2 ready', { exact: true }).waitFor()
  assert.equal(
    await page
      .locator('article')
      .first()
      .getByLabel('Amount', { exact: true })
      .inputValue(),
    '0.2'
  )

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByText('2 of 2 ready', { exact: true }).waitFor()
  assert.equal(
    await page.getByLabel('Proposal title', { exact: true }).inputValue(),
    'Fund community research'
  )
  assert.equal(
    await page
      .locator('article')
      .first()
      .getByLabel('Amount', { exact: true })
      .inputValue(),
    '0.2'
  )
  await page.locator('#proposal-actions-heading').scrollIntoViewIfNeeded()
  await page.screenshot({
    path: `${output}/desktop-builder.png`,
    fullPage: true,
  })

  await page
    .getByRole('button', { name: 'Review proposal', exact: true })
    .click()
  await page.getByRole('heading', { name: 'Review your proposal.' }).waitFor()
  await page.getByLabel('Include my vote', { exact: true }).check()
  await page.getByRole('radio', { name: 'Vote against', exact: true }).click()
  assert.equal(
    await page
      .getByRole('radio', { name: 'Vote against', exact: true })
      .getAttribute('aria-checked'),
    'true'
  )
  await page.screenshot({
    path: `${output}/desktop-review.png`,
    fullPage: true,
  })
  await noOverflow()

  for (const width of [390, 320, 768, 1024]) {
    await page.setViewportSize({ width, height: 844 })
    await noOverflow()
    await page.screenshot({
      path: `${output}/${width}-review.png`,
      fullPage: true,
    })
  }
  await page.evaluate(() =>
    document.documentElement.setAttribute('data-theme', 'light')
  )
  await page.setViewportSize({ width: 1440, height: 1000 })
  await noOverflow()
  await page.screenshot({ path: `${output}/light-review.png`, fullPage: true })
  await page.evaluate(() =>
    document.documentElement.setAttribute('data-theme', 'dark')
  )
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  for (const width of [390, 320, 768, 1024]) {
    await page.setViewportSize({ width, height: 844 })
    await noOverflow()
    await page.screenshot({
      path: `${output}/${width}-builder.png`,
      fullPage: true,
    })
  }

  const fingerprint = `0x${'a'.repeat(64)}`
  await page.evaluate(
    ({ network, fingerprint }) => {
      localStorage.setItem(
        `trustgraph:governance-prefill:${network}:${fingerprint}`,
        JSON.stringify({
          version: 2,
          networkId: network,
          fingerprint,
          title: 'Imported action draft',
          description: 'Preserve settings workflow drafts.',
          createdAt: Date.now(),
          actions: [
            {
              actionKey: 'send-eth',
              values: {
                recipient: '0x2222222222222222222222222222222222222222',
                amountEth: '0.3',
              },
            },
          ],
        })
      )
    },
    { network, fingerprint }
  )
  await page.goto(`${origin}${route}?new=1&actionDraft=${fingerprint}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForURL(`**${route}/new?actionDraft=${fingerprint}`)
  await page.getByText('1 of 1 ready', { exact: true }).waitFor()
  assert.equal(
    await page.getByLabel('Proposal title', { exact: true }).inputValue(),
    'Imported action draft'
  )
  await page.goto(`${origin}${route}/new`, { waitUntil: 'domcontentloaded' })
  await page.getByText('2 of 2 ready', { exact: true }).waitFor()
  assert.equal(
    await page.getByLabel('Proposal title', { exact: true }).inputValue(),
    'Fund community research',
    'imported and new proposal drafts must stay separate'
  )
  assert.deepEqual(errors, [], 'browser should have no uncaught errors')
  console.log(
    'governance browser smoke: routing, legacy draft links, validation, search, filters, duplicate/reorder/undo, autosave, signal votes, review, voting controls, and responsive layouts passed'
  )
} finally {
  await browser.close()
}
