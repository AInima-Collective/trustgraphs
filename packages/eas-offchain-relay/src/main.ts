import { ViemRelayChain } from './chain.ts'
import { loadConfig } from './config.ts'
import { IpfsBlockStore } from './ipfs.ts'
import { createRelayServer } from './server.ts'
import { RelaySubmissionService } from './service.ts'

const config = loadConfig()
const chain = new ViemRelayChain(
  config.rpcUrl,
  config.relay.registry,
  config.relayerPrivateKey
)
const stores = config.ipfsTargets.map((target) => new IpfsBlockStore(target))
const service = new RelaySubmissionService(config.relay, chain, stores)
const server = createRelayServer({
  service,
  maxBodyBytes: config.relay.maxBodyBytes,
  allowedOrigins: config.allowedOrigins,
})

server.listen(config.port, config.host, () => {
  process.stdout.write(
    `${JSON.stringify({ event: 'relay_started', host: config.host, port: config.port })}\n`
  )
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close((error) => {
      if (error)
        process.stderr.write(
          `${JSON.stringify({ event: 'relay_shutdown_error' })}\n`
        )
      process.exit(error ? 1 : 0)
    })
  })
}
