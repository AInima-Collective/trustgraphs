import process from 'node:process'

const required = (name) => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}
const positive = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`)
  return value
}
const nonnegativeBigInt = (name, fallback = '0') => {
  const value = process.env[name] ?? fallback
  if (!/^\d+$/.test(value))
    throw new Error(`${name} must be a nonnegative integer`)
  return BigInt(value)
}

const indexer = required('MONITOR_INDEXER_URL').replace(/\/$/, '')
const operator = required('MONITOR_OPERATOR_URL').replace(/\/$/, '')
const rpcUrl = required('MONITOR_RPC_URL')
const webhook = process.env.MONITOR_ALERT_WEBHOOK?.trim()
const intervalSeconds = positive('MONITOR_INTERVAL_SECONDS', 60)
const maxLagBlocks = positive('MONITOR_INDEXER_MAX_LAG_BLOCKS', 20)
const maxOperatorStale = positive('MONITOR_OPERATOR_MAX_STALE_SECONDS', 300)
const staleRootBlocks = positive('MONITOR_STALE_ROOT_BLOCKS', 7200)
const minVaultEth = nonnegativeBigInt('MONITOR_MIN_VAULT_ETH_WEI')
const minVaultUsdc = nonnegativeBigInt('MONITOR_MIN_VAULT_USDC')
const requireRoot = (process.env.MONITOR_REQUIRE_ROOT ?? 'true') === 'true'
const once = (process.env.MONITOR_ONCE ?? 'false') === 'true'
const active = new Set()

const fetchWithDeadline = async (url, init = {}) => {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok)
    throw new Error(`${new URL(url).pathname} returned HTTP ${response.status}`)
  return response
}
const json = async (url, init) => (await fetchWithDeadline(url, init)).json()
const rpc = async (method, params = []) => {
  const body = await json(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (body.error)
    throw new Error(`${method}: ${body.error.message ?? 'JSON-RPC error'}`)
  return body.result
}
const metric = (text, name, labels = '') => {
  const suffix = labels ? `\\{${labels}\\}` : ''
  const match = text.match(
    new RegExp(`^${name}${suffix}\\s+([0-9.eE+-]+)$`, 'm')
  )
  return match ? Number(match[1]) : undefined
}

async function notify(text) {
  console.error(text)
  if (!webhook) return
  try {
    await fetchWithDeadline(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    })
  } catch (error) {
    console.error(`monitor alert delivery failed: ${error.message}`)
  }
}

async function evaluate() {
  const findings = new Map()
  const add = (key, text) => findings.set(key, text)
  const [indexerReady, operatorReady, metrics, status, instances, headHex] =
    await Promise.allSettled([
      fetchWithDeadline(`${indexer}/ready`),
      fetchWithDeadline(`${operator}/ready`),
      fetchWithDeadline(`${indexer}/metrics`).then((response) =>
        response.text()
      ),
      json(`${operator}/status`),
      json(`${indexer}/instances?limit=200&offset=0`),
      rpc('eth_blockNumber'),
    ])

  if (indexerReady.status === 'rejected')
    add('indexer-ready', `indexer not ready: ${indexerReady.reason.message}`)
  if (operatorReady.status === 'rejected')
    add('operator-ready', `operator not ready: ${operatorReady.reason.message}`)

  if (metrics.status === 'fulfilled' && headHex.status === 'fulfilled') {
    const synced = metric(
      metrics.value,
      'ponder_sync_block',
      'chain="sepolia"'
    )
    const head = Number(BigInt(headHex.value))
    if (synced === undefined)
      add('indexer-sync-metric', 'indexer exposes no Sepolia sync-block metric')
    else if (head - synced > maxLagBlocks)
      add(
        'indexer-lag',
        `indexer is ${head - synced} blocks behind Sepolia (threshold ${maxLagBlocks})`
      )
  } else {
    if (metrics.status === 'rejected')
      add(
        'indexer-metrics',
        `indexer metrics unavailable: ${metrics.reason.message}`
      )
    if (headHex.status === 'rejected')
      add('rpc-head', `Sepolia head unavailable: ${headHex.reason.message}`)
  }

  if (status.status === 'fulfilled') {
    const age =
      Math.floor(Date.now() / 1000) - Number(status.value.tick_at ?? 0)
    if (!Number.isFinite(age) || age > maxOperatorStale)
      add(
        'operator-stale',
        `operator heartbeat is ${age}s old (threshold ${maxOperatorStale}s)`
      )
    for (const instance of status.value.instances ?? []) {
      const id = instance.instance_id ?? instance.name ?? 'unknown'
      if (instance.blocks_since_root == null && requireRoot)
        add(`root-missing:${id}`, `${id} has never landed a root`)
      else if (Number(instance.blocks_since_root) > staleRootBlocks)
        add(
          `root-stale:${id}`,
          `${id} root is ${instance.blocks_since_root} blocks old (threshold ${staleRootBlocks})`
        )
      const action = instance.action ?? {}
      // `publish` is an ordinary active phase. Page only when a failed publication has moved the
      // instance into its durable retry backoff; the operator's own alert webhook covers the
      // detailed target error without exposing credential-bearing transport text through status.
      if (
        action.action === 'idle' &&
        action.idle === 'publication_backoff'
      )
        add(
          `publication:${id}`,
          `${id} is backing off after a score publication failure`
        )
    }
  } else {
    add(
      'operator-status',
      `operator status unavailable: ${status.reason.message}`
    )
  }

  if (instances.status === 'fulfilled') {
    for (const instance of instances.value.instances ?? []) {
      const id = instance.id ?? instance.instanceId
      if (!id) continue
      try {
        const vault = await json(`${indexer}/vault/${id}`)
        if (!vault.funded) continue
        const reserveChecks = []
        if (minVaultEth > 0n)
          reserveChecks.push(BigInt(vault.ethBalance) < minVaultEth)
        if (minVaultUsdc > 0n)
          reserveChecks.push(BigInt(vault.usdcBalance) < minVaultUsdc)
        if (reserveChecks.length > 0 && reserveChecks.every(Boolean))
          add(
            `vault-low:${id}`,
            `${id} proving vault is below every configured reserve threshold`
          )
        if (Number(vault.unpaidRootsSinceLastPayment ?? 0) > 0)
          add(
            `vault-unpaid:${id}`,
            `${id} has ${vault.unpaidRootsSinceLastPayment} unpaid root(s)`
          )
      } catch (error) {
        add(
          `vault-unreadable:${id}`,
          `${id} vault status unavailable: ${error.message}`
        )
      }
    }
  } else {
    add('instances', `instance catalog unavailable: ${instances.reason.message}`)
  }

  for (const [key, text] of findings) {
    if (!active.has(key)) await notify(`Trustgraphs Sepolia alert: ${text}`)
  }
  for (const key of active) {
    if (!findings.has(key)) console.log(`Trustgraphs Sepolia recovered: ${key}`)
  }
  active.clear()
  for (const key of findings.keys()) active.add(key)
  if (findings.size === 0) console.log(`monitor ok ${new Date().toISOString()}`)
}

for (;;) {
  try {
    await evaluate()
  } catch (error) {
    await notify(`Trustgraphs Sepolia monitor failed: ${error.message}`)
  }
  if (once) break
  await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000))
}
