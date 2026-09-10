import assert from 'node:assert/strict'

import { chromium } from 'playwright'

const baseUrl = new URL(
  process.env.WALLET_FRONTEND_URL?.trim() || 'http://127.0.0.1:3000'
)
const createUrl = new URL('/create/standard', baseUrl).toString()
const browser = await chromium.launch({ headless: true })

const firstAccount = '0x1000000000000000000000000000000000000001'
const secondAccount = '0x2000000000000000000000000000000000000002'

try {
  const context = await browser.newContext()
  await context.addInitScript(
    ({ initialAccount }) => {
      const listeners = new Map()
      const persistedAccounts = window.localStorage.getItem(
        'tg-wallet-smoke-accounts'
      )
      let accounts = persistedAccounts
        ? JSON.parse(persistedAccounts)
        : [initialAccount]
      let chainId =
        window.localStorage.getItem('tg-wallet-smoke-chain-id') || '0x1'
      const requests = []

      const emit = (event, value) => {
        for (const listener of listeners.get(event) || []) listener(value)
      }

      const provider = {
        request: async ({ method, params }) => {
          requests.push({ method, params })
          if (method === 'eth_accounts' || method === 'eth_requestAccounts') {
            return accounts
          }
          if (method === 'eth_chainId') return chainId
          if (method === 'wallet_requestPermissions') {
            return [
              {
                parentCapability: 'eth_accounts',
                caveats: [
                  { type: 'restrictReturnedAccounts', value: accounts },
                ],
              },
            ]
          }
          if (method === 'wallet_revokePermissions') return null
          if (method === 'wallet_switchEthereumChain') {
            chainId = params[0].chainId
            window.localStorage.setItem('tg-wallet-smoke-chain-id', chainId)
            emit('chainChanged', chainId)
            return null
          }
          if (method === 'wallet_addEthereumChain') return null
          throw Object.assign(
            new Error(`Unsupported smoke RPC method: ${method}`),
            {
              code: -32601,
            }
          )
        },
        on: (event, listener) => {
          const eventListeners = listeners.get(event) || new Set()
          eventListeners.add(listener)
          listeners.set(event, eventListeners)
        },
        removeListener: (event, listener) => {
          listeners.get(event)?.delete(listener)
        },
      }

      Object.defineProperty(window, 'ethereum', {
        configurable: true,
        value: provider,
      })
      Object.defineProperty(window, '__tgWalletSmoke', {
        configurable: true,
        value: {
          requests,
          setAccounts(nextAccounts) {
            accounts = nextAccounts
            window.localStorage.setItem(
              'tg-wallet-smoke-accounts',
              JSON.stringify(accounts)
            )
            emit('accountsChanged', accounts)
          },
        },
      })
    },
    { initialAccount: firstAccount }
  )

  const page = await context.newPage()
  await page.goto(createUrl, { waitUntil: 'domcontentloaded' })

  const requestsBeforeConnect = await page.evaluate(
    () => window.__tgWalletSmoke.requests
  )
  assert.deepEqual(
    requestsBeforeConnect,
    [],
    'the injected provider was queried before explicit connection intent'
  )

  await page.getByRole('button', { name: 'Connect account' }).first().click()
  await page.getByRole('button', { name: 'Browser wallet' }).click()
  await page
    .getByRole('button', { name: /Account menu, 0x100\.\.001/ })
    .waitFor()

  await page.getByRole('button', { name: 'Switch to Local Anvil' }).click()
  await page
    .getByRole('button', { name: 'Switch to Local Anvil' })
    .waitFor({ state: 'detached' })

  await page.evaluate(
    (account) => window.__tgWalletSmoke.setAccounts([account]),
    secondAccount
  )
  await page
    .getByRole('button', { name: /Account menu, 0x200\.\.002/ })
    .waitFor()

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page
    .getByRole('button', { name: /Account menu, 0x200\.\.002/ })
    .waitFor()

  await page.getByRole('button', { name: /Account menu, 0x200\.\.002/ }).click()
  await page.getByRole('button', { name: 'Disconnect' }).click()
  await page.getByRole('button', { name: 'Connect account' }).first().waitFor()

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Connect account' }).first().waitFor()

  console.log(
    JSON.stringify({
      url: createUrl,
      providerRequestsBeforeConnect: requestsBeforeConnect.length,
      connection: true,
      accountSwitch: true,
      chainSwitch: true,
      reconnect: true,
      disconnect: true,
    })
  )
} finally {
  await browser.close()
}
