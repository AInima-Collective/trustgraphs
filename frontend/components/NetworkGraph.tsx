'use client'

import '@react-sigma/core/lib/style.css'

import {
  ControlsContainer,
  FullScreenControl,
  SigmaContainer,
  ZoomControl,
  useCamera,
  useLoadGraph,
  useRegisterEvents,
  useSetSettings,
  useSigma,
} from '@react-sigma/core'
import { useLayoutCircular } from '@react-sigma/layout-circular'
import { useWorkerLayoutForceAtlas2 } from '@react-sigma/layout-forceatlas2'
import {
  DEFAULT_EDGE_CURVATURE,
  EdgeCurvedArrowProgram,
  indexParallelEdgesIndex,
} from '@sigma/edge-curve'
import { MultiDirectedGraph } from 'graphology'
import { circular } from 'graphology-layout'
import forceAtlas2, { ForceAtlas2Settings } from 'graphology-layout-forceatlas2'
import ForceAtlas2LayoutWorker from 'graphology-layout-forceatlas2/worker'
import { ArrowRight, CircleDashed, LoaderCircle, Waypoints } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTheme } from 'next-themes'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EdgeArrowProgram } from 'sigma/rendering'
import { NodeDisplayData } from 'sigma/types'
import { animateNodes } from 'sigma/utils'
import { Hex } from 'viem'

import { BrandMark } from '@/components/BrandMark'
import { useNetwork } from '@/contexts/NetworkContext'
import {
  GraphTokens,
  nodeColorForValue,
  readGraphTokens,
} from '@/lib/graphTheme'
import {
  NetworkGraphHoverState,
  NetworkGraphManager,
} from '@/lib/NetworkGraphManager'
import { NetworkGraphEdge, NetworkGraphNode } from '@/lib/types'
import { cn, formatBigNumber, isHexEqual } from '@/lib/utils'

const forceAtlas2SettingsOverrides: ForceAtlas2Settings = {
  // Bind nodes more tightly together.
  gravity: 1,

  // Push hubs outwards to highlight them (disrupts spatial balance)
  // outboundAttractionDistribution: true,
}
const forceAtlas2Duration = 250

const edgeSizeForConfidence = (
  confidence: number | null,
  minConfidence: number,
  maxConfidence: number
) => {
  if (confidence === null || maxConfidence <= minConfidence) return 1.1
  const ratio = Math.max(
    0,
    Math.min(1, (confidence - minConfidence) / (maxConfidence - minConfidence))
  )
  return 0.9 + ratio * 1.8
}

// https://github.com/jacomyal/sigma.js/blob/main/packages/storybook/stories/3-additional-packages/edge-curve/parallel-edges.ts
const getCurvature = (index: number, maxIndex: number): number => {
  if (maxIndex <= 0) throw new Error('Invalid maxIndex')
  if (index < 0) return -getCurvature(-index, maxIndex)
  const amplitude = 3.5
  const maxCurvature =
    amplitude * (1 - Math.exp(-maxIndex / amplitude)) * DEFAULT_EDGE_CURVATURE
  return (maxCurvature * index) / maxIndex
}

export interface NetworkGraphProps {
  /** Title to display. */
  title?: string
  /** Only show attestations connected to this address. */
  onlyAddress?: Hex
  className?: string
  /** Initial zoom level. > 1.0 zooms out, < 1.0 zooms in. Defaults to 1.25. */
  initialZoom?: number
  /**
   * Render the zoom / fullscreen / layout controls. On by default, because on a
   * network's own page they are how you read a dense graph.
   *
   * The landing hero turns them OFF. Sigma paints to a canvas that is not in the
   * accessibility tree, and everything the controls reveal (score, edge weight)
   * arrives through mouse-hover tooltips with no keyboard equivalent, so on the
   * marketing route they were five tab stops between the primary CTA and the
   * rest of the page, all operating something a keyboard user cannot read. The
   * hero is one labelled picture instead.
   */
  chrome?: boolean
  /** Render the contextual node/edge inspector. Defaults to the chrome value. */
  inspector?: boolean
  /**
   * Let pointer gestures pan the camera and deliberate inputs (pinch, buttons,
   * keyboard) zoom it. Ordinary wheel events always remain page scroll. The
   * nearly full-screen landing graph turns camera control off entirely.
   */
  cameraControls?: boolean
  /** Optional editorial introduction shown before the graph is inspected. */
  guide?: {
    heading: string
    description: string
    actions?: Array<{
      href: string
      label: string
    }>
  }
}

export function NetworkGraph({
  title,
  onlyAddress,
  className,
  initialZoom = 1.25,
  chrome = true,
  inspector = chrome,
  cameraControls = true,
  guide,
}: NetworkGraphProps) {
  const router = useRouter()

  // `graphLoading`, not `isLoading`. The aggregate folds in the Gnosis Safe read,
  // which this component never draws and which climbs a four-attempt retry
  // ladder when the indexer is unreachable. Measured: the graph's own two reads
  // terminated at 8.0s and this component held its spinner, and its
  // `data-settling` flag, for the whole of a 48s window. An earlier round moved
  // the hero's outer wrapper onto `graphLoading` and stopped here, which fixed
  // nothing a reader could see: the screenshot harness waits for EVERY
  // `[data-settling]` node, and the spinner is painted by this file.
  const {
    network,
    graphLoading,
    error,
    accountData,
    attestationsData,
    isTrustedSeed,
  } = useNetwork()

  // Sigma paints via WebGL and cannot read CSS variables, so the palette is
  // resolved off <html> and the graph is rebuilt when the theme changes.
  const { resolvedTheme } = useTheme()
  const graphTokens = useMemo(() => readGraphTokens(), [resolvedTheme])

  // React Sigma otherwise falls back to its light-only defaults (#ccc edges,
  // black labels). Keep every canvas/WebGL colour on the same token snapshot
  // used to build the graph, so a theme change updates the whole renderer.
  const sigmaSettings = useMemo(
    () => ({
      renderLabels: true,
      allowInvalidContainer: true,
      defaultNodeColor: graphTokens.nodeMid,
      defaultEdgeColor: graphTokens.edge,
      defaultEdgeType: 'straight' as const,
      labelFont: graphTokens.fontFamily,
      labelSize: 11,
      labelWeight: 'normal',
      labelColor: { color: graphTokens.label },
      edgeLabelFont: graphTokens.fontFamily,
      edgeLabelSize: 10,
      edgeLabelWeight: 'normal',
      edgeLabelColor: { color: graphTokens.label },
      enableEdgeEvents: true,
      minEdgeThickness: 0.8,
      stagePadding: 36,
      zIndex: true,
      enableCameraZooming: cameraControls,
      enableCameraPanning: cameraControls,
      edgeProgramClasses: {
        straight: EdgeArrowProgram,
        curved: EdgeCurvedArrowProgram,
      },
    }),
    [cameraControls, graphTokens]
  )

  const [showCursor, setShowCursor] = useState(false)

  const [isLoadingGraph, setIsLoadingGraph] = useState(false)
  const [graph, setGraph] = useState<MultiDirectedGraph<
    NetworkGraphNode,
    NetworkGraphEdge
  > | null>(null)

  // Load graph from data.
  useEffect(() => {
    if (!accountData || !attestationsData) {
      setGraph(null)
      setIsLoadingGraph(false)
      return
    }

    setIsLoadingGraph(true)

    // Create the graph
    const graph = new MultiDirectedGraph<NetworkGraphNode, NetworkGraphEdge>()

    const maxValue = Number(
      accountData.reduce(
        (max, { value }) => (BigInt(value) > max ? BigInt(value) : max),
        0n
      )
    )
    const minValue = Number(
      accountData.reduce(
        (min, { value }) => (BigInt(value) < min ? BigInt(value) : min),
        BigInt(maxValue)
      )
    )

    const minNodeSize = 7
    const maxNodeSize = 17

    // Skip attestations that are not connected to the onlyAddress, if set.
    const attestations = attestationsData.filter(
      (attestation) =>
        !onlyAddress ||
        isHexEqual(attestation.attester, onlyAddress) ||
        isHexEqual(attestation.recipient, onlyAddress)
    )

    for (const { account, value, sent, received, ensName } of accountData) {
      // Skip accounts not included in the graph.
      if (
        !attestations.some(
          (attestation) =>
            isHexEqual(attestation.attester, account) ||
            isHexEqual(attestation.recipient, account)
        )
      ) {
        continue
      }

      // Normalize value to 0-100 scale
      const normalizedValue =
        maxValue === minValue
          ? 50 // Default to middle if all values are the same
          : ((Number(value) - minValue) / (maxValue - minValue)) * 100
      const normalizedRatio = normalizedValue / 100

      const href = `/account/${account}`
      const seed = isTrustedSeed(account)
      router.prefetch(href)

      graph.addNode(account.toLowerCase(), {
        href,
        label: ensName || `${account.slice(0, 6)}...${account.slice(-4)}`,
        x: 0,
        y: 0,
        value: BigInt(value),
        sent,
        received,
        isSeed: seed,
        // Circle area, rather than radius, tracks score. The square root keeps
        // low-score members legible without letting one outlier swallow the map.
        size:
          minNodeSize +
          Math.sqrt(normalizedRatio) * (maxNodeSize - minNodeSize),
        // Fill grades by PageRank mass alone: heaviest node is the one with
        // the most contrast against the canvas, in either theme.
        color: nodeColorForValue(normalizedValue, graphTokens),
      })
    }

    for (const attestation of attestations) {
      const source = attestation.attester.toLowerCase()
      const target = attestation.recipient.toLowerCase()
      if (!graph.hasNode(source) || !graph.hasNode(target)) continue

      const rawConfidence = attestation.decodedData?.confidence
      const parsedConfidence =
        rawConfidence === undefined || rawConfidence === null
          ? null
          : Number(rawConfidence)
      const confidence =
        parsedConfidence !== null && Number.isFinite(parsedConfidence)
          ? parsedConfidence
          : null
      const comment = attestation.decodedData?.comment
      const inactive = attestation.status !== 'verified'

      graph.addEdgeWithKey(attestation.uid, source, target, {
        href: `/attestations/${attestation.uid}`,
        label:
          confidence === null
            ? 'Confidence unknown'
            : `${confidence}% confidence`,
        confidence,
        comment:
          typeof comment === 'string' && comment.trim()
            ? comment.trim()
            : undefined,
        status: attestation.status,
        formattedTime: attestation.formattedTime,
        formattedTimeAgo: attestation.formattedTimeAgo,
        size: edgeSizeForConfidence(
          confidence,
          network.pagerank.minWeight,
          network.pagerank.maxWeight
        ),
        color: inactive ? graphTokens.edgeRevoked : graphTokens.edge,
      })
    }

    // Curve parallel edges so they're all visible / not overlapping
    // https://github.com/jacomyal/sigma.js/blob/main/packages/storybook/stories/3-additional-packages/edge-curve/parallel-edges.ts

    // Use dedicated helper to identify parallel edges:
    indexParallelEdgesIndex(graph, {
      edgeIndexAttribute: 'parallelIndex',
      edgeMinIndexAttribute: 'parallelMinIndex',
      edgeMaxIndexAttribute: 'parallelMaxIndex',
    })

    // Adapt types and curvature of parallel edges for rendering:
    graph.forEachEdge(
      (
        edge,
        {
          parallelIndex,
          parallelMinIndex,
          parallelMaxIndex,
        }:
          | {
              parallelIndex: number
              parallelMinIndex?: number
              parallelMaxIndex: number
            }
          | {
              parallelIndex?: null
              parallelMinIndex?: null
              parallelMaxIndex?: null
            }
      ) => {
        if (typeof parallelMinIndex === 'number') {
          graph.mergeEdgeAttributes(edge, {
            type: parallelIndex ? 'curved' : 'straight',
            curvature: getCurvature(parallelIndex, parallelMaxIndex),
          })
        } else if (typeof parallelIndex === 'number') {
          graph.mergeEdgeAttributes(edge, {
            type: 'curved',
            curvature: getCurvature(parallelIndex, parallelMaxIndex),
          })
        } else {
          graph.setEdgeAttribute(edge, 'type', 'straight')
        }
      }
    )

    circular.assign(graph, {
      scale: 100,
    })

    if (graph.order === 0) {
      setGraph(graph)
      setIsLoadingGraph(false)
      return
    }

    // Initialize force atlas 2 layout, then hold still. Cleanup matters here:
    // a theme or data change can otherwise let an older worker overwrite the
    // fresh graph after it finishes settling.
    const layout = new ForceAtlas2LayoutWorker(graph, {
      settings: {
        ...forceAtlas2.inferSettings(graph),
        ...forceAtlas2SettingsOverrides,
      },
    })

    let layoutKilled = false
    const killLayout = () => {
      if (layoutKilled) return
      layout.stop()
      layout.kill()
      layoutKilled = true
    }

    layout.start()
    const settleTimeout = window.setTimeout(() => {
      killLayout()

      setGraph(graph)
      setIsLoadingGraph(false)
    }, forceAtlas2Duration)

    return () => {
      window.clearTimeout(settleTimeout)
      killLayout()
    }
  }, [
    accountData,
    attestationsData,
    isTrustedSeed,
    graphTokens,
    network.pagerank.minWeight,
    network.pagerank.maxWeight,
    onlyAddress,
    router,
  ])

  const settling = graphLoading || (isLoadingGraph && !graph)

  return (
    <div
      className={cn(
        'relative w-full h-full overflow-hidden isolate',
        className
      )}
      // The screenshot harness (frontend/scripts/shots.mjs) waits for every
      // [data-settling] node to clear before it shoots, so a review matrix
      // never captures a spinner and calls it a design. Keep the attribute
      // absent rather than "false" when settled: the harness counts nodes.
      data-settling={settling ? 'true' : undefined}
    >
      {settling ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 border border-border p-4">
          <LoaderCircle size={20} className="animate-spin text-text-subtle" />
          <span className="tg-label">Building graph</span>
        </div>
      ) : error || !attestationsData || !graph || graph.size === 0 ? (
        // An empty network is not a failure — it is a network nobody has
        // attested in yet, and it gets the neutral empty state. Only a real
        // fetch error takes the error tone.
        <div
          className={cn(
            'flex h-full w-full flex-col items-center justify-center gap-3 border p-6 text-center',
            error ? 'border-error' : 'border-border'
          )}
        >
          <BrandMark
            size="lg"
            className={error ? 'text-error/60' : 'text-text-subtle/40'}
          />
          <span
            className={cn(
              'text-xs uppercase tracking-wider',
              error ? 'text-error' : 'text-text-subtle'
            )}
          >
            {error ? 'Graph unavailable' : 'No attestations yet'}
          </span>
          <p className="max-w-[36ch] text-xs text-text-subtle">
            {error
              ? error
              : onlyAddress
                ? 'This member has no connected attestations in the current view.'
                : 'The first attestation in this network will draw the first edge.'}
          </p>
        </div>
      ) : (
        graph && (
          <SigmaContainer
            className={cn(
              'border border-border',
              cameraControls &&
                'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ink',
              showCursor && 'cursor-pointer'
            )}
            settings={sigmaSettings}
            graph={MultiDirectedGraph}
          >
            <SigmaControls
              title={title}
              graph={graph}
              setShowCursor={setShowCursor}
              defaultLayout="forceatlas2"
              initialZoom={initialZoom}
              chrome={chrome}
              inspector={inspector}
              cameraControls={cameraControls}
              guide={guide}
              graphTokens={graphTokens}
            />
          </SigmaContainer>
        )
      )}
    </div>
  )
}

const SigmaControls = ({
  title,
  graph,
  setShowCursor,
  defaultLayout,
  initialZoom,
  chrome = true,
  inspector,
  cameraControls,
  guide,
  graphTokens,
}: {
  title?: string
  graph: MultiDirectedGraph<NetworkGraphNode, NetworkGraphEdge>
  setShowCursor: (hovering: boolean) => void
  defaultLayout: 'circular' | 'forceatlas2'
  initialZoom?: number
  chrome?: boolean
  inspector: boolean
  cameraControls: boolean
  guide?: NetworkGraphProps['guide']
  graphTokens: GraphTokens
}) => {
  const sigma = useSigma()
  const registerEvents = useRegisterEvents()
  const loadGraph = useLoadGraph()
  const setSettings = useSetSettings()
  const { reset: recenter } = useCamera()
  const { zoomIn, zoomOut } = useCamera({
    duration: 200,
    factor: 1.5,
  })

  useEffect(() => {
    const graphRoot = sigma.getContainer().parentElement
    if (!graphRoot) return

    const previousRole = graphRoot.getAttribute('role')
    const previousLabel = graphRoot.getAttribute('aria-label')
    const previousTabIndex = graphRoot.getAttribute('tabindex')

    // Keep the non-camera hero a group rather than an image: its guide can
    // contain real links, and role="img" would flatten those descendants out
    // of the accessibility tree.
    graphRoot.setAttribute('role', cameraControls ? 'region' : 'group')
    graphRoot.setAttribute(
      'aria-label',
      cameraControls
        ? 'Interactive trust graph. Hover or tap a node or edge to inspect it. Drag to pan, pinch or use plus and minus to zoom.'
        : 'Trust graph showing members as nodes and vouches as connecting edges.'
    )

    if (!cameraControls) {
      return () => {
        restoreAttribute(graphRoot, 'role', previousRole)
        restoreAttribute(graphRoot, 'aria-label', previousLabel)
      }
    }

    graphRoot.tabIndex = 0

    // Sigma handles wheel and touch zoom behind one shared camera setting. Keep
    // that setting enabled for real pinch gestures, but stop ordinary wheel
    // events before they reach Sigma's mouse captor. We intentionally do not
    // prevent the browser default: the page should continue scrolling. Modern
    // trackpads report pinch as a ctrl-modified wheel event, which remains a
    // deliberate graph zoom alongside native two-finger touch pinch.
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) event.stopPropagation()
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (
        target instanceof Element &&
        target.closest('a, button, input, select, textarea, [contenteditable]')
      ) {
        return
      }

      graphRoot.focus({ preventScroll: true })
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        (target instanceof HTMLElement &&
          (target.isContentEditable ||
            Boolean(target.closest('input, select, textarea'))))
      ) {
        return
      }

      const zoomingIn =
        event.key === '+' || event.key === '=' || event.code === 'NumpadAdd'
      const zoomingOut =
        event.key === '-' ||
        event.key === '_' ||
        event.code === 'NumpadSubtract'

      if (!zoomingIn && !zoomingOut) return

      event.preventDefault()
      if (zoomingIn) void zoomIn()
      else void zoomOut()
    }

    graphRoot.addEventListener('wheel', handleWheel, { capture: true })
    graphRoot.addEventListener('pointerdown', handlePointerDown, {
      capture: true,
    })
    graphRoot.addEventListener('keydown', handleKeyDown)

    return () => {
      graphRoot.removeEventListener('wheel', handleWheel, { capture: true })
      graphRoot.removeEventListener('pointerdown', handlePointerDown, {
        capture: true,
      })
      graphRoot.removeEventListener('keydown', handleKeyDown)
      restoreAttribute(graphRoot, 'role', previousRole)
      restoreAttribute(graphRoot, 'aria-label', previousLabel)
      restoreAttribute(graphRoot, 'tabindex', previousTabIndex)
    }
  }, [cameraControls, sigma, zoomIn, zoomOut])

  useEffect(() => {
    if (initialZoom) {
      const camera = sigma.getCamera()
      camera.ratio = initialZoom
      sigma.refresh()
    }
  }, [sigma, initialZoom])

  const { positions: circularPositions } = useLayoutCircular({ scale: 100 })
  const { start: startForceAtlas2, stop: stopForceAtlas2 } =
    useWorkerLayoutForceAtlas2({
      settings: {
        ...forceAtlas2.inferSettings(graph),
        ...forceAtlas2SettingsOverrides,
      },
    })

  const [layout, setLayout] = useState<typeof defaultLayout>(defaultLayout)

  const stopAnimationRef = useRef<() => void>(() => {})

  const setCircularLayout = useCallback(() => {
    stopAnimationRef.current()
    setLayout('circular')
    recenter()
    stopAnimationRef.current = animateNodes(
      sigma.getGraph(),
      circularPositions(),
      {
        duration: forceAtlas2Duration,
        easing: 'linear',
      },
      () => recenter()
    )
  }, [sigma, circularPositions, recenter])

  const setForceAtlas2Layout = useCallback(() => {
    stopAnimationRef.current()
    setLayout('forceatlas2')
    recenter()
    startForceAtlas2()

    const stop = () => {
      stopForceAtlas2()
      recenter()
      clearTimeout(timeout)
      stopAnimationRef.current = () => {}
    }
    const timeout = setTimeout(stop, forceAtlas2Duration)
    stopAnimationRef.current = stop
  }, [startForceAtlas2, stopForceAtlas2, recenter])

  const [hoverState, setHoverState] = useState<NetworkGraphHoverState>(null)
  useEffect(() => {
    loadGraph(graph)

    const manager = new NetworkGraphManager({
      graph,
      hoverDelay: 50,
      unhoverDelay: 75,
      onStateChange: (state, shouldShowCursor) => {
        setHoverState(state)
        setShowCursor(shouldShowCursor)
      },
      onLayoutUpdate: () => {},
    })

    // Register event handlers
    manager.register(registerEvents)

    return () => manager.cleanup()
  }, [graph, loadGraph, registerEvents, setHoverState, setShowCursor])

  useEffect(() => {
    setSettings({
      nodeReducer: (node, data) => {
        const newData: Partial<NodeDisplayData> = {
          ...data,
          highlighted: data.highlighted || false,
        }

        if (hoverState) {
          if (hoverState.nodes.includes(node)) {
            newData.highlighted = true
          } else {
            newData.color = graphTokens.dim
            newData.highlighted = false
            newData.label = ''
          }
        }

        return newData
      },
      edgeReducer: (edge, data) => {
        if (!hoverState) return data

        const focused = hoverState.edges.includes(edge)
        const inactive = data.status !== 'verified'
        return {
          ...data,
          // Retain the full topology as a quiet scaffold. Making unrelated
          // paths disappear causes a jarring context switch in dense maps.
          color: focused
            ? inactive
              ? graphTokens.edgeRevoked
              : graphTokens.edgeActive
            : graphTokens.dim,
          size: focused
            ? Math.max(data.size * 1.55, 2.6)
            : Math.max(data.size * 0.55, 0.55),
          zIndex: focused ? 1 : 0,
        }
      },
    })
  }, [setSettings, hoverState, graphTokens])

  return (
    <>
      {chrome && (
        <ControlsContainer
          position="top-right"
          className="tg-graph-toolbar flex flex-row"
        >
          <ZoomControl
            labels={{
              zoomIn: 'Zoom in (+)',
              zoomOut: 'Zoom out (−)',
              reset: 'See whole graph',
            }}
          />
          <FullScreenControl />

          {layout === 'circular' ? (
            <div className="react-sigma-control">
              <button
                title="Use force-directed layout"
                aria-label="Use force-directed layout"
                onClick={setForceAtlas2Layout}
              >
                <Waypoints width="1em" height="1em" />
              </button>
            </div>
          ) : (
            <div className="react-sigma-control">
              <button
                title="Use circular layout"
                aria-label="Use circular layout"
                onClick={setCircularLayout}
              >
                <CircleDashed width="1em" height="1em" />
              </button>
            </div>
          )}
        </ControlsContainer>
      )}

      {inspector && (
        <GraphInspector
          title={title}
          graph={graph}
          hoverState={hoverState}
          cameraControls={cameraControls}
          guide={guide}
        />
      )}
    </>
  )
}

function GraphInspector({
  title,
  graph,
  hoverState,
  cameraControls,
  guide,
}: {
  title?: string
  graph: MultiDirectedGraph<NetworkGraphNode, NetworkGraphEdge>
  hoverState: NetworkGraphHoverState
  cameraControls: boolean
  guide?: NetworkGraphProps['guide']
}) {
  return (
    <section
      aria-live="polite"
      aria-label="Graph inspector"
      className="pointer-events-none absolute inset-x-3 bottom-3 z-10 sm:right-auto sm:w-[22rem]"
    >
      <div className="border border-hairline-strong bg-surface/95 px-3.5 py-3 backdrop-blur-md shadow-[var(--shadow-elevated)] transition-[opacity,transform] duration-150">
        {!hoverState ? (
          <GraphGuide
            title={title}
            graph={graph}
            cameraControls={cameraControls}
            guide={guide}
          />
        ) : hoverState.type === 'edge' ? (
          <EdgeInspector graph={graph} hoverState={hoverState} />
        ) : (
          <NodeInspector graph={graph} hoverState={hoverState} />
        )}
      </div>
    </section>
  )
}

function GraphGuide({
  title,
  graph,
  cameraControls,
  guide,
}: {
  title?: string
  graph: MultiDirectedGraph<NetworkGraphNode, NetworkGraphEdge>
  cameraControls: boolean
  guide?: NetworkGraphProps['guide']
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-4">
        <p className="text-xs uppercase tracking-wider text-text">
          {guide?.heading || title || 'Network map'}
        </p>
        <p className="hidden whitespace-nowrap text-[10px] text-text-subtle sm:block">
          {graph.order} {graph.order === 1 ? 'member' : 'members'} ·{' '}
          {graph.size} {graph.size === 1 ? 'vouch' : 'vouches'}
        </p>
      </div>

      {guide?.description && (
        <p className="text-[11px] leading-relaxed text-text-muted">
          {guide.description}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[10px] text-text-muted">
        <span className="inline-flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full border border-text-subtle bg-text-muted" />
          node = member · area = score
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="h-px w-5 bg-text-muted" />
          edge = vouch · weight = confidence
        </span>
      </div>

      {guide?.actions && guide.actions.length > 0 && (
        <nav
          aria-label="Graph links"
          className="pointer-events-auto grid grid-cols-2 border-y border-hairline"
        >
          {guide.actions.map((action, index) => (
            <Link
              key={action.href}
              href={action.href}
              prefetch={false}
              className={cn(
                'group flex min-h-10 items-center justify-between gap-3 py-2 text-[10px] uppercase tracking-wider text-text transition-colors hover:text-text-muted focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ink',
                index === 0 ? 'border-r border-hairline pr-3' : 'pl-3'
              )}
            >
              {action.label}
              <ArrowRight
                aria-hidden="true"
                className="h-3.5 w-3.5 shrink-0 transition-transform group-hover:translate-x-0.5"
              />
            </Link>
          ))}
        </nav>
      )}

      <p className="text-[10px] leading-relaxed text-text-subtle">
        Hover or tap a node or edge to inspect it.
        {cameraControls && ' Drag to explore; pinch or press + / − to zoom.'}
      </p>
    </div>
  )
}

function restoreAttribute(
  element: HTMLElement,
  name: string,
  value: string | null
) {
  if (value === null) element.removeAttribute(name)
  else element.setAttribute(name, value)
}

function EdgeInspector({
  graph,
  hoverState,
}: {
  graph: MultiDirectedGraph<NetworkGraphNode, NetworkGraphEdge>
  hoverState: Exclude<NetworkGraphHoverState, null>
}) {
  const edge = graph.getEdgeAttributes(hoverState.target)
  const [source, target] = graph.extremities(hoverState.target)
  const sourceNode = graph.getNodeAttributes(source)
  const targetNode = graph.getNodeAttributes(target)
  const statusLabel =
    edge.status === 'verified'
      ? 'Active vouch'
      : edge.status === 'revoked'
        ? 'Revoked vouch'
        : 'Expired vouch'

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <p
          className={cn(
            'inline-flex items-center gap-2 text-[10px] uppercase tracking-wider',
            edge.status === 'verified'
              ? 'text-success'
              : edge.status === 'revoked'
                ? 'text-error'
                : 'text-warn'
          )}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-current" />
          {statusLabel}
        </p>
        <time
          className="text-[10px] text-text-subtle"
          title={edge.formattedTime}
        >
          {edge.formattedTimeAgo}
        </time>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
        <GraphPerson label={sourceNode.label} address={source} side="from" />
        <ArrowRight aria-hidden="true" className="h-4 w-4 text-text-subtle" />
        <GraphPerson label={targetNode.label} address={target} side="to" />
      </div>

      <div className="flex items-end justify-between gap-4 border-t border-hairline pt-2.5">
        <div>
          <p className="text-[9px] uppercase tracking-wider text-text-subtle">
            Confidence
          </p>
          <p className="mt-0.5 text-lg leading-none text-text">
            {edge.confidence === null ? 'Unknown' : `${edge.confidence}%`}
          </p>
        </div>
        <p className="max-w-[18ch] text-right text-[10px] leading-relaxed text-text-subtle">
          {hoverState.touch === 'first'
            ? 'Tap again to open the record'
            : 'Click the edge to open the record'}
        </p>
      </div>

      {edge.comment && (
        <p className="line-clamp-3 border-l border-hairline-strong pl-2.5 text-[11px] leading-relaxed text-text-muted">
          “{edge.comment}”
        </p>
      )}
    </div>
  )
}

function GraphPerson({
  label,
  address,
  side,
}: {
  label: string
  address: string
  side: 'from' | 'to'
}) {
  return (
    <div className={cn('min-w-0', side === 'to' && 'text-right')}>
      <p className="text-[9px] uppercase tracking-wider text-text-subtle">
        {side}
      </p>
      <p className="truncate text-xs text-text" title={address}>
        {label}
      </p>
    </div>
  )
}

function NodeInspector({
  graph,
  hoverState,
}: {
  graph: MultiDirectedGraph<NetworkGraphNode, NetworkGraphEdge>
  hoverState: Exclude<NetworkGraphHoverState, null>
}) {
  const node = graph.getNodeAttributes(hoverState.target)

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[9px] uppercase tracking-wider text-text-subtle">
            {node.isSeed ? 'Seed member' : 'Network member'}
          </p>
          <p
            className="mt-0.5 truncate text-sm text-text"
            title={hoverState.target}
          >
            {node.label}
          </p>
        </div>
        <p className="shrink-0 text-right text-[10px] leading-relaxed text-text-subtle">
          {hoverState.touch === 'first'
            ? 'Tap again to view profile'
            : 'Click to view profile'}
        </p>
      </div>

      <div className="grid grid-cols-3 border-t border-hairline pt-2.5">
        <GraphMetric
          label="Trust score"
          value={formatBigNumber(node.value, 18)}
        />
        <GraphMetric label="Received" value={node.received.toLocaleString()} />
        <GraphMetric label="Given" value={node.sent.toLocaleString()} />
      </div>
    </div>
  )
}

function GraphMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-l border-hairline px-2 first:border-l-0 first:pl-0 last:pr-0">
      <p className="text-[9px] uppercase tracking-wider text-text-subtle">
        {label}
      </p>
      <p className="mt-1 text-xs text-text">{value}</p>
    </div>
  )
}
