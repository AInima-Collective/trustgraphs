import CONFIG from '../config.json'
import networks from '../networks.json'
import { AnyNetwork, HypercertsNetwork, Network } from './types'

const ALL_NETWORKS = networks as AnyNetwork[]

// The address-keyed EAS vouching networks (everything the existing pipeline consumes).
export const NETWORKS = ALL_NETWORKS.filter(
  (network): network is Network => network.program !== 'hypercerts'
)
export const VISIBLE_NETWORKS = NETWORKS.filter((network) => !network.hidden)

// The nodeId-keyed hypercerts instances (read-only detail pages fed by the /hypercerts API).
export const HYPERCERTS_NETWORKS = ALL_NETWORKS.filter(
  (network): network is HypercertsNetwork => network.program === 'hypercerts'
)
export const VISIBLE_HYPERCERTS_NETWORKS = HYPERCERTS_NETWORKS.filter(
  (network) => !network.hidden
)

export const CHAIN = CONFIG.chain
export const APIS = CONFIG.apis
export const CONTRACT_CONFIG = CONFIG.contracts
