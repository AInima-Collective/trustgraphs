import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

/**
 * Browser smoke for a public deployment, testnet or mainnet.
 *
 * ONE SCRIPT FOR BOTH SITES. The same application is served at
 * testnet.trustgraphs.xyz and trustgraphs.xyz, so the site under test is
 * `FRONTEND_URL` and the chain is whatever the generated `config.json` says
 * the checkout was built for: `chain` names a target in
 * `lib/application-targets.json`, and that chain id is the read proxy's path
 * (`/api/rpc/<chainId>`) the failover assertion watches. The `SEPOLIA_*`
 * names are accepted for the runbooks that still use them.
 */
const frontendDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const configuredUrl = (
  process.env.FRONTEND_URL ?? process.env.SEPOLIA_FRONTEND_URL
)?.trim()
if (!configuredUrl) {
  throw new Error('FRONTEND_URL is required')
}
const baseUrl = new URL(configuredUrl)
const createUrl = new URL('/create', baseUrl).toString()
const expectRpcFailover =
  (process.env.EXPECT_RPC_FAILOVER ??
    process.env.SEPOLIA_EXPECT_RPC_FAILOVER) === 'true'

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(
        `Missing ${file}; generate and link the frontend configuration for the target under test first`
      )
    }
    throw error
  }
}
const { chain } = readJson(path.join(frontendDir, 'config.json'))
const targets = readJson(path.join(frontendDir, 'lib/application-targets.json'))
if (!Object.hasOwn(targets, chain)) {
  throw new Error(
    `config.json names an unsupported application chain: ${chain}`
  )
}
const chainId = String(targets[chain])
const rpcPath = `/api/rpc/${chainId}`

const browser = await chromium.launch({ headless: true })

try {
  const context = await browser.newContext()
  const page = await context.newPage()
  const rpcResponses = []
  page.on('response', (response) => {
    const url = new URL(response.url())
    if (url.pathname !== rpcPath) return
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
  assert.doesNotMatch(body, /Testnet assets have no value/i)
  assert.match(body, /Start a standard network/i)
  assert.match(body, /Weighted starting shares/i)
  assert.match(body, /Compose proved scoreboards/i)
  assert.ok(hrefs.includes('/create/weighted'))
  assert.ok(hrefs.includes('/create/composition'))
  assert.equal(
    await page.evaluate(() => typeof window.ethereum),
    'undefined',
    'smoke context unexpectedly has an injected wallet'
  )

  await page.getByRole('button', { name: /Start a standard network/i }).click()
  await page
    .getByText(/Connect the wallet that will create this network/i)
    .waitFor()

  if (expectRpcFailover) {
    assert.ok(
      rpcResponses.some(({ id, status }) => id === '0' && status >= 500),
      `primary RPC on ${rpcPath} was not observed failing: ${JSON.stringify(rpcResponses)}`
    )
    assert.ok(
      rpcResponses.some(({ id, status }) => id === '1' && status === 200),
      `secondary RPC on ${rpcPath} was not observed succeeding: ${JSON.stringify(rpcResponses)}`
    )
  }

  console.log(
    JSON.stringify({
      url: createUrl,
      chain,
      chainId,
      title: await page.title(),
      testnetBanner: false,
      standardCreationOffered: true,
      programCreationEntriesAvailable: true,
      cleanWalletContext: true,
      rpcFailover: expectRpcFailover ? rpcResponses : 'not requested',
    })
  )
} finally {
  await browser.close()
}
