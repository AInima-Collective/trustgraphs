// A TCP proxy that can be told to stop answering, so a test can wedge the daemon's chain reads
// without killing the chain.
//
// This exists because the failure a readiness probe is FOR is not "the process died" — a dead
// process is obvious from the outside. It is the one where the socket is still open, the request
// is gone, and nothing ever comes back. Killing anvil produces connection-refused, which the
// daemon handles in milliseconds and keeps ticking; only a hang makes the last completed tick go
// stale while the process stays perfectly responsive.
//
//   PORT=8561 UPSTREAM=8560 MARKER=/tmp/wedge node tests/e2e/rpc-blackhole.mjs
//
// Creating MARKER wedges it. Removing MARKER unwedges it. Both act on connections that already
// exist, because an HTTP client with a warm keep-alive pool would otherwise never notice.

import net from 'node:net'
import fs from 'node:fs'

const PORT = Number(process.env.PORT || 8561)
const UPSTREAM = Number(process.env.UPSTREAM || 8545)
const HOST = process.env.UPSTREAM_HOST || '127.0.0.1'
const MARKER = process.env.MARKER || '/tmp/rpc-blackhole.on'

/** Sockets being held open with no answer, so they can be released when the wedge lifts. */
const held = new Set()
/** Live forwarded pairs, so they can be cut when the wedge starts. */
const forwarded = new Set()

let wedged = fs.existsSync(MARKER)

const server = net.createServer((client) => {
  client.on('error', () => {})
  if (wedged) {
    held.add(client)
    client.on('close', () => held.delete(client))
    return
  }
  const upstream = net.connect(UPSTREAM, HOST)
  const pair = { client, upstream }
  forwarded.add(pair)
  const drop = () => {
    forwarded.delete(pair)
    client.destroy()
    upstream.destroy()
  }
  upstream.on('error', drop)
  client.on('error', drop)
  client.on('close', drop)
  client.pipe(upstream)
  upstream.pipe(client)
})

setInterval(() => {
  const now = fs.existsSync(MARKER)
  if (now === wedged) return
  wedged = now
  if (wedged) {
    // Cut warm connections so the next request has to open a new one and gets held.
    for (const { client, upstream } of forwarded) {
      client.destroy()
      upstream.destroy()
    }
    forwarded.clear()
    console.log('blackhole: wedged')
  } else {
    // Release the held sockets so the blocked client fails fast and retries, instead of waiting
    // out an OS-level connect timeout minutes later.
    for (const client of held) client.destroy()
    held.clear()
    console.log('blackhole: forwarding')
  }
}, 200).unref?.()

server.listen(PORT, '127.0.0.1', () => {
  console.log(`blackhole proxy :${PORT} -> :${UPSTREAM} (marker ${MARKER})`)
})
