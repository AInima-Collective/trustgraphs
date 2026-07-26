'use client'

/**
 * Sigma renders through WebGL and needs literal colour strings, not `var(--…)`.
 * Rather than duplicate the palette in TypeScript, this reads the resolved
 * token values off <html> at call time — tokens.css stays the single source of
 * truth, and a theme flip is picked up by re-reading rather than by keeping a
 * second copy in sync.
 *
 * Callers must re-read (and rebuild the graph) when [data-theme] changes; see
 * the `resolvedTheme` dependency in NetworkGraph.
 */

export type GraphTokens = {
  canvas: string
  nodeLo: string
  nodeMid: string
  nodeHi: string
  nodeStroke: string
  nodeSelected: string
  edge: string
  edgeStrong: string
  edgeActive: string
  edgeRevoked: string
  label: string
  labelHi: string
  dim: string
}

// Matches the dark block in tokens.css. Used during SSR and in the window
// before styles resolve; both paths re-read on the client immediately after.
const FALLBACK: GraphTokens = {
  canvas: '#0a0b0c',
  nodeLo: '#3f4245',
  nodeMid: '#7b7f83',
  nodeHi: '#eceef0',
  nodeStroke: '#0a0b0c',
  nodeSelected: '#eceef0',
  edge: '#34363a',
  edgeStrong: '#6a6e72',
  edgeActive: '#eceef0',
  edgeRevoked: '#c47f79',
  label: '#a1a5a9',
  labelHi: '#eceef0',
  dim: '#1a1b1d',
}

const VAR_NAMES: Record<keyof GraphTokens, string> = {
  canvas: '--graph-canvas',
  nodeLo: '--graph-node-lo',
  nodeMid: '--graph-node-mid',
  nodeHi: '--graph-node-hi',
  nodeStroke: '--graph-node-stroke',
  nodeSelected: '--graph-node-selected',
  edge: '--graph-edge',
  edgeStrong: '--graph-edge-strong',
  edgeActive: '--graph-edge-active',
  edgeRevoked: '--graph-edge-revoked',
  label: '--graph-label',
  labelHi: '--graph-label-hi',
  dim: '--graph-dim',
}

export function readGraphTokens(): GraphTokens {
  if (typeof window === 'undefined') return FALLBACK
  const cs = getComputedStyle(document.documentElement)
  const out = {} as GraphTokens
  for (const key of Object.keys(VAR_NAMES) as (keyof GraphTokens)[]) {
    out[key] = cs.getPropertyValue(VAR_NAMES[key]).trim() || FALLBACK[key]
  }
  return out
}

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace('#', '').trim()
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h
  const n = parseInt(full, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = parseHex(a)
  const [r2, g2, b2] = parseHex(b)
  const r = Math.round(r1 + (r2 - r1) * t)
  const g = Math.round(g1 + (g2 - g1) * t)
  const bl = Math.round(b1 + (b2 - b1) * t)
  return `rgb(${r}, ${g}, ${bl})`
}

/**
 * Node fill for a PageRank value normalised to 0–100.
 *
 * The ramp runs lo → mid → hi with no hue in it, so a node's weight reads as
 * its *value* against the canvas: on the dark theme the heaviest node is the
 * brightest, on light it is the darkest. Colour is reserved for protocol
 * state (a revoked edge), never for magnitude.
 */
export function nodeColorForValue(value: number, tokens: GraphTokens): string {
  const v = Math.max(0, Math.min(100, value)) / 100
  return v < 0.5
    ? mix(tokens.nodeLo, tokens.nodeMid, v * 2)
    : mix(tokens.nodeMid, tokens.nodeHi, (v - 0.5) * 2)
}
