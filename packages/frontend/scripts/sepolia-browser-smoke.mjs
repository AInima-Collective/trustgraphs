import assert from 'node:assert/strict'

import { chromium } from 'playwright'

const configuredUrl = process.env.SEPOLIA_FRONTEND_URL?.trim()
if (!configuredUrl) {
  throw new Error('SEPOLIA_FRONTEND_URL is required')
}
const baseUrl = new URL(configuredUrl)
const createUrl = new URL('/create', baseUrl).toString()
const expectRpcFailover = process.env.SEPOLIA_EXPECT_RPC_FAILOVER === 'true'
const browser = await chromium.launch({ headless: true })

try {
  const context = await browser.newContext()
  const page = await context.newPage()
  const rpcResponses = []
  page.on('response', (response) => {
    const url = new URL(response.url())
    if (url.pathname !== '/api/rpc/11155111') return
    rpcResponses.push({
      id: url.searchParams.get('id') ?? '0',
      status: response.status(),
    })
  })
  await page.goto(createUrl, { waitUntil: 'networkidle' })

  const body = await page.locator('body').innerText()
  const hrefs = await page
    .locator('a')
    .evaluateAll((links) => links.map((link) => link.getAttribute('href')))
  assert.match(body, /Ethereum Sepolia · Testnet assets have no value/i)
  assert.match(body, /Start a standard network/i)
  assert.doesNotMatch(body, /Weighted starting shares/i)
  assert.doesNotMatch(body, /Compose proved scoreboards/i)
  assert.ok(!hrefs.includes('/create/weighted'))
  assert.ok(!hrefs.includes('/create/composition'))
  assert.equal(
    await page.evaluate(() => typeof window.ethereum),
    'undefined',
    'smoke context unexpectedly has an injected wallet'
  )

  await page
    .getByRole('button', { name: /Start a standard network/i })
    .click()
  await page
    .getByText(/Connect the wallet that will create this network/i)
    .waitFor()

  if (expectRpcFailover) {
    assert.ok(
      rpcResponses.some(({ id, status }) => id === '0' && status >= 500),
      `primary RPC was not observed failing: ${JSON.stringify(rpcResponses)}`
    )
    assert.ok(
      rpcResponses.some(({ id, status }) => id === '1' && status === 200),
      `secondary RPC was not observed succeeding: ${JSON.stringify(rpcResponses)}`
    )
  }

  console.log(
    JSON.stringify({
      url: createUrl,
      title: await page.title(),
      testnetBanner: true,
      standardCreationOffered: true,
      optionalCreationEntriesHidden: true,
      cleanWalletContext: true,
      rpcFailover: expectRpcFailover ? rpcResponses : 'not requested',
    })
  )
} finally {
  await browser.close()
}
