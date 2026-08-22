#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const loadPlaywright = () => {
  try {
    return require('playwright')
  } catch {
    return require('/usr/lib/node_modules/playwright')
  }
}
const { chromium } = loadPlaywright()

const required = (name) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

const phase = required('EAS_OFFCHAIN_BROWSER_PHASE')
const app = required('EAS_OFFCHAIN_BROWSER_APP_URL').replace(/\/$/, '')
const rpc = required('RPC')
const account = required('EAS_OFFCHAIN_BROWSER_ACCOUNT')
const output = required('EAS_OFFCHAIN_BROWSER_OUTPUT_FILE')
const instanceId =
  phase === 'create-network'
    ? process.env.EAS_OFFCHAIN_BROWSER_INSTANCE_ID
    : required('EAS_OFFCHAIN_BROWSER_INSTANCE_ID')
const recipient =
  phase === 'create-network'
    ? process.env.EAS_OFFCHAIN_BROWSER_RECIPIENT
    : required('EAS_OFFCHAIN_BROWSER_RECIPIENT')
const expectedCid = process.env.EAS_OFFCHAIN_BROWSER_EXPECTED_CID
const expectedCount = process.env.EAS_OFFCHAIN_BROWSER_EXPECTED_COUNT
const networkName =
  process.env.EAS_OFFCHAIN_BROWSER_NETWORK_NAME ||
  'browser-created-strict-eas-e2e'

if (
  ![
    'create-network',
    'onchain-create',
    'create',
    'render-revoke',
    'render-final',
  ].includes(phase)
) {
  throw new Error(`unsupported browser phase ${phase}`)
}

let rpcId = 0
const rpcCall = async (method, params = []) => {
  const response = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: ++rpcId,
      method,
      params,
    }),
  })
  const body = await response.json()
  if (!response.ok || body.error) {
    throw new Error(`${method}: ${JSON.stringify(body.error ?? body)}`)
  }
  return body.result
}

const installAnvilProvider = async (context) => {
  await context.addInitScript(
    ({ rpcUrl, selectedAccount }) => {
      const listeners = new Map()
      let nextId = 0
      const emit = (event, value) => {
        for (const listener of listeners.get(event) ?? []) listener(value)
      }
      const provider = {
        isMetaMask: true,
        isConnected: () => true,
        on(event, listener) {
          const current = listeners.get(event) ?? []
          current.push(listener)
          listeners.set(event, current)
          return provider
        },
        removeListener(event, listener) {
          listeners.set(
            event,
            (listeners.get(event) ?? []).filter(
              (candidate) => candidate !== listener
            )
          )
          return provider
        },
        async request({ method, params = [] }) {
          window.__tgE2eRpcMethods ??= []
          window.__tgE2eRpcMethods.push(method)
          if (method === 'eth_requestAccounts' || method === 'eth_accounts') {
            return [selectedAccount]
          }
          if (method === 'wallet_requestPermissions') {
            return [{ parentCapability: 'eth_accounts' }]
          }
          if (method === 'wallet_getPermissions') {
            return [
              {
                parentCapability: 'eth_accounts',
                caveats: [
                  {
                    type: 'restrictReturnedAccounts',
                    value: [selectedAccount],
                  },
                ],
              },
            ]
          }
          if (method === 'wallet_switchEthereumChain') {
            emit('chainChanged', params?.[0]?.chainId ?? '0x7a69')
            return null
          }
          if (method === 'wallet_addEthereumChain') return null

          const response = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: ++nextId,
              method,
              params,
            }),
          })
          const body = await response.json()
          if (body.error) {
            const error = new Error(body.error.message)
            error.code = body.error.code
            error.data = body.error.data
            throw error
          }
          if (method === 'eth_sendTransaction') {
            window.__tgE2eTransactionHashes ??= []
            window.__tgE2eTransactionHashes.push(body.result)
          }
          return body.result
        },
      }
      Object.defineProperty(window, 'ethereum', {
        configurable: false,
        enumerable: true,
        value: provider,
      })
      window.dispatchEvent(new Event('ethereum#initialized'))
    },
    { rpcUrl: rpc, selectedAccount: account }
  )
}

const connect = async (page) => {
  const accountMenu = page
    .getByRole('button', {
      name: /Account menu/i,
    })
    .first()
  if (
    await accountMenu
      .waitFor({ state: 'visible', timeout: 2_000 })
      .then(() => true)
      .catch(() => false)
  ) {
    return
  }

  // The popup closes on the route effect that follows hydration. If that
  // effect races the first click, reopen it; the connector itself is stable.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const connectButton = page
      .getByRole('button', {
        name: 'Connect account',
      })
      .first()
    await connectButton.waitFor({ timeout: 10_000 })
    await connectButton.click()
    const expanded = await page
      .waitForFunction(
        () =>
          document
            .querySelector('button[aria-label="Connect account"]')
            ?.getAttribute('aria-expanded') === 'true',
        undefined,
        { timeout: 2_000 }
      )
      .then(() => true)
      .catch(() => false)
    if (!expanded) {
      await page.keyboard.press('Escape')
      continue
    }
    const injected = page
      .getByText('Browser wallet', { exact: true })
      .locator('xpath=ancestor::button[1]')
      .first()
    await injected.waitFor({ state: 'attached', timeout: 5_000 })
    // The panel's entrance animation can briefly report a zero geometry even
    // after aria-expanded has committed. It is logically open at this point;
    // activate its real button without waiting on the transform animation.
    await injected.click({ force: true })
    if (
      await accountMenu
        .waitFor({ state: 'visible', timeout: 8_000 })
        .then(() => true)
        .catch(() => false)
    ) {
      return
    }
  }

  const methods = await page.evaluate(() => window.__tgE2eRpcMethods ?? [])
  throw new Error(
    `browser wallet did not connect; RPC methods: ${JSON.stringify(methods)}; visible page: ${(await page.locator('body').innerText()).slice(0, 2_000)}`
  )
}

const openVouch = async (page) => {
  await page
    .getByRole('button', { name: /^Make attestation$/i })
    .first()
    .click()
  const dialog = page.getByRole('dialog', { name: 'Make attestation' })
  await dialog.waitFor()
  return dialog
}

const fillRecipient = async (dialog) => {
  await dialog.getByLabel('RECIPIENT').fill(recipient)
}

const mineUntil = async (work) => {
  const miner = setInterval(() => {
    void rpcCall('evm_mine').catch(() => undefined)
  }, 750)
  try {
    return await work()
  } finally {
    clearInterval(miner)
  }
}

const verifyIndependentRoot = async (page) => {
  await page.getByRole('button', { name: 'SIMULATE' }).click()
  const popup = page
    .locator('[role="dialog"]:visible')
    .filter({ hasText: 'Strict-lane verification' })
  await popup.getByRole('button', { name: /Disabled/ }).click()
  await popup
    .getByText('Strict-lane verification: verified', { exact: true })
    .waitFor({ timeout: 90_000 })
  await popup
    .getByText(/The exact-parameter browser root matches the published root\./)
    .waitFor()
  await page.keyboard.press('Escape')
}

const waitForVerified = async (dialog) => {
  await mineUntil(() =>
    dialog
      .getByText('Finalized and independently verified', { exact: true })
      .waitFor({ timeout: 90_000 })
  )
}

const downloadBundle = async (page, dialog) => {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog
      .getByRole('button', { name: 'Export recoverable signed bundle' })
      .click(),
  ])
  const path = await download.path()
  assert.ok(path, 'browser did not retain the exported bundle download')
  const bundle = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(bundle.protocol, 'TrustgraphsEasOffchainBundleV1')
  await writeFile(output, `${JSON.stringify(bundle, null, 2)}\n`)
  return bundle
}

const assertWalletOnly = async (page, expectedSignatures) => {
  await assertWalletActivity(page, 0, expectedSignatures)
}

const assertWalletActivity = async (
  page,
  expectedTransactions,
  expectedSignatures
) => {
  const methods = await page.evaluate(() => window.__tgE2eRpcMethods ?? [])
  assert.equal(
    methods.filter((method) => method === 'eth_sendTransaction').length,
    expectedTransactions,
    'unexpected number of wallet-paid transactions'
  )
  assert.equal(
    methods.filter((method) => method === 'eth_signTypedData_v4').length,
    expectedSignatures,
    'unexpected number of typed wallet signature prompts'
  )
}

const walletTransactionHashes = (page) =>
  page.evaluate(() => window.__tgE2eTransactionHashes ?? [])

const createHybridNetwork = async (page) => {
  await page.goto(`${app}/create`, {
    waitUntil: 'domcontentloaded',
    timeout: 90_000,
  })
  await page.getByRole('button', { name: 'Start a standard network' }).click()
  await connect(page)

  await page.getByLabel('Name').fill(networkName)
  await page.getByRole('button', { name: 'Continue' }).click()
  await page
    .getByRole('heading', { name: 'Who does your community already trust?' })
    .waitFor({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Add my account' }).click()
  await page.getByText('1 of 64 added', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page
    .getByRole('heading', { name: 'How scores are worked out' })
    .waitFor()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('heading', { name: 'Add a shared fund?' }).waitFor()

  const gaslessCard = page
    .getByText('Gasless off-chain vouches', { exact: true })
    .locator('xpath=ancestor::div[contains(@class,"space-y-3")][1]')
  await assert.rejects(
    gaslessCard.getByText('Immutable proof-work cap').waitFor({ timeout: 500 }),
    undefined,
    'the standard wizard must remain on-chain-only by default'
  )
  await gaslessCard.locator('.cursor-pointer').click()
  await gaslessCard.getByText('Immutable proof-work cap').waitFor()
  await page.getByRole('button', { name: 'Continue' }).click()

  await page
    .getByRole('heading', { name: 'Check it over, then sign once' })
    .waitFor()
  await page
    .getByText('Yes — strict retained EAS v2, alongside on-chain vouches', {
      exact: true,
    })
    .waitFor()
  const preflightPassed = await page
    .getByText('Everything checks out. Signing will create the network.', {
      exact: true,
    })
    .waitFor({ timeout: 30_000 })
    .then(() => true)
    .catch(() => false)
  if (!preflightPassed) {
    throw new Error(
      `hybrid creation preflight did not pass; visible page: ${(await page.locator('body').innerText()).slice(0, 8_000)}`
    )
  }
  await page.getByRole('button', { name: 'Create network' }).click()
  await mineUntil(() =>
    page
      .getByRole('heading', { name: `${networkName} is live` })
      .waitFor({ timeout: 120_000 })
  )

  const networkHref = await page
    .getByRole('link', { name: 'Go to your network' })
    .getAttribute('href')
  const createdInstanceId = networkHref?.split('/').at(-1)
  assert.match(
    createdInstanceId ?? '',
    /^0x[0-9a-f]{64}$/i,
    'creation success did not expose a 32-byte instance id'
  )
  const registryRow = page
    .getByText('Strict off-chain vouch anchors', { exact: true })
    .locator('xpath=..')
  const registry = (await registryRow.locator('button').innerText()).trim()
  assert.match(
    registry,
    /^0x[0-9a-f]{40}$/i,
    'creation success did not expose the strict registry'
  )
  await assertWalletActivity(page, 1, 0)
  const transactionHashes = await walletTransactionHashes(page)
  assert.equal(transactionHashes.length, 1)
  await writeFile(
    output,
    `${JSON.stringify(
      {
        phase,
        name: networkName,
        instanceId: createdInstanceId,
        registry,
        transactionHash: transactionHashes[0],
        defaultMode: 'onchain',
        selectedMode: 'hybrid',
      },
      null,
      2
    )}\n`
  )
}

const main = async () => {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1280, height: 900 },
  })
  await installAnvilProvider(context)
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  try {
    if (phase === 'create-network') {
      await createHybridNetwork(page)
      assert.deepEqual(
        pageErrors,
        [],
        `browser page errors: ${pageErrors.join('; ')}`
      )
      process.stdout.write(`STRICT EAS OFFCHAIN BROWSER ${phase} PASS\n`)
      return
    }

    await page.goto(`${app}/networks/${instanceId}`, {
      // Wagmi deliberately keeps an RPC WebSocket open, so networkidle is not a
      // reachable navigation state. The authenticated network title below is
      // the application-level readiness assertion.
      waitUntil: 'domcontentloaded',
      timeout: 90_000,
    })
    await page.getByText(networkName, { exact: true }).first().waitFor()
    if (phase !== 'render-final') await connect(page)

    if (phase === 'onchain-create') {
      const dialog = await openVouch(page)
      await dialog.getByRole('button', { name: 'Gasless off-chain' }).waitFor()
      await dialog.getByRole('button', { name: 'On-chain EAS' }).click()
      await fillRecipient(dialog)
      await dialog
        .getByPlaceholder(
          'Add any additional context about your vouching decision...'
        )
        .fill('browser-created on-chain predecessor')
      await dialog.getByRole('checkbox').click()
      await dialog.getByRole('button', { name: 'Make Attestation' }).click()
      const closed = await mineUntil(() =>
        dialog
          .waitFor({ state: 'hidden', timeout: 90_000 })
          .then(() => true)
          .catch(() => false)
      )
      if (!closed) {
        const methods = await page.evaluate(
          () => window.__tgE2eRpcMethods ?? []
        )
        const hashes = await walletTransactionHashes(page)
        throw new Error(
          `on-chain vouch did not close after submission; RPC methods: ${JSON.stringify(methods)}; transaction hashes: ${JSON.stringify(hashes)}; visible dialog: ${(await dialog.innerText()).slice(0, 8_000)}`
        )
      }
      await assertWalletActivity(page, 1, 0)
      const transactionHashes = await walletTransactionHashes(page)
      assert.equal(transactionHashes.length, 1)
      await writeFile(
        output,
        `${JSON.stringify(
          { phase, passed: true, transactionHash: transactionHashes[0] },
          null,
          2
        )}\n`
      )
    } else if (phase === 'create') {
      const dialog = await openVouch(page)
      await dialog.getByRole('button', { name: 'Gasless off-chain' }).waitFor()
      // Prove provenance dispatch remains a visible user choice, then return to the strict lane.
      await dialog.getByRole('button', { name: 'On-chain EAS' }).click()
      await dialog.getByRole('button', { name: 'Gasless off-chain' }).click()
      await fillRecipient(dialog)
      await dialog
        .getByPlaceholder(
          'Add any additional context about your vouching decision...'
        )
        .fill('browser-created gasless vouch')
      await dialog.getByRole('checkbox').click()
      await dialog.getByRole('button', { name: 'Make Attestation' }).click()
      await dialog.getByText('Review the exact EAS v2 typed message').waitFor()
      await dialog
        .getByRole('button', { name: 'Sign this EAS v2 vouch' })
        .click()
      await dialog
        .getByText('Review the exact append-head typed message')
        .waitFor()
      await dialog
        .getByRole('button', { name: 'Sign append head and relay' })
        .click()
      await waitForVerified(dialog)
      const bundle = await downloadBundle(page, dialog)
      assert.equal(bundle.message.count, expectedCount ?? '3')
      await assertWalletOnly(page, 2)
    } else if (phase === 'render-revoke') {
      assert.ok(expectedCid, 'render-revoke requires expected CID')
      await verifyIndependentRoot(page)
      const audit = page.getByRole('region', {
        name: 'Current vouch provenance',
      })
      await audit.getByText('Off-chain EAS', { exact: true }).waitFor()
      await audit.getByText(`CID ${expectedCid}`, { exact: true }).waitFor()
      await audit
        .getByText(/Storage healthy · indexer independently verified/)
        .waitFor()

      const dialog = await openVouch(page)
      await fillRecipient(dialog)
      await dialog
        .getByRole('button', { name: 'Revoke off-chain' })
        .waitFor({ timeout: 30_000 })
      await dialog.getByRole('button', { name: 'Revoke off-chain' }).click()
      await dialog
        .getByText('Review the exact append-head typed message')
        .waitFor()
      await dialog.getByText('operation').waitFor()
      await dialog.getByText('revoke', { exact: true }).waitFor()
      await dialog
        .getByRole('button', { name: 'Sign append head and relay' })
        .click()
      await waitForVerified(dialog)
      const bundle = await downloadBundle(page, dialog)
      assert.equal(bundle.message.count, expectedCount ?? '4')
      await dialog.getByText(/Current result: no vouch for this pair/).waitFor()
      await assertWalletOnly(page, 1)
    } else {
      const audit = page.getByRole('region', {
        name: 'Current vouch provenance',
      })
      await audit
        .getByText(
          /No current vouches\. A revoke tombstone never reveals an older vouch/
        )
        .waitFor()
      await assertWalletOnly(page, 0)
      await writeFile(output, `${JSON.stringify({ phase, passed: true })}\n`)
    }

    assert.deepEqual(
      pageErrors,
      [],
      `browser page errors: ${pageErrors.join('; ')}`
    )
    process.stdout.write(`STRICT EAS OFFCHAIN BROWSER ${phase} PASS\n`)
  } finally {
    await context.close()
    await browser.close()
  }
}

await main()
