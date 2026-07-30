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
import { CircleDashed, LoaderCircle, Waypoints } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useTheme } from 'next-themes'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EdgeArrowProgram } from 'sigma/rendering'
import { NodeDisplayData } from 'sigma/types'
import { animateNodes } from 'sigma/utils'
import { Hex } from 'viem'

import { BrandMark } from '@/components/BrandMark'
import { useNetwork } from '@/contexts/NetworkContext'
import { useBatchEnsQuery } from '@/hooks/useEns'
import { nodeColorForValue, readGraphTokens } from '@/lib/graphTheme'
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
}

export function NetworkGraph({
  title,
  onlyAddress,
  className,
  initialZoom = 1.25,
  chrome = true,
}: NetworkGraphProps) {
  const router = useRouter()

  const { isLoading, error, accountData, attestationsData, isTrustedSeed } =
    useNetwork()

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
      labelColor: { color: graphTokens.label },
      edgeLabelColor: { color: graphTokens.label },
      enableEdgeEvents: true,
      edgeProgramClasses: {
        straight: EdgeArrowProgram,
        curved: EdgeCurvedArrowProgram,
      },
    }),
    [graphTokens]
  )

  // Load ENS data
  const { data: ensData } = useBatchEnsQuery(
    accountData.map((account) => account.account) || []
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

    const minNodeSize = 8
    const maxNodeSize = 16

    // const minConfidence = 0
    // const maxConfidence = 100
    // const minEdgeSize = 2
    // const maxEdgeSize = 8
    const edgeSize = 1

    // Skip attestations that are not connected to the onlyAddress, if set.
    const attestations = attestationsData.filter(
      (attestation) =>
        !onlyAddress ||
        isHexEqual(attestation.attester, onlyAddress) ||
        isHexEqual(attestation.recipient, onlyAddress)
    )

    for (const { account, value, sent, received } of accountData) {
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

      const ensName = ensData?.[account]?.name
      const href = `/account/${ensName || account}`
      router.prefetch(href)

      graph.addNode(account.toLowerCase(), {
        href,
        label:
          (ensName || `${account.slice(0, 6)}...${account.slice(-4)}`) +
          (isTrustedSeed(account) ? ' 🌱' : ''),
        x: 0,
        y: 0,
        value: BigInt(value),
        sent,
        received,
        // Set size to relative value, scaled to a range
        size: minNodeSize + normalizedRatio * (maxNodeSize - minNodeSize),
        // Fill grades by PageRank mass alone: heaviest node is the one with
        // the most contrast against the canvas, in either theme.
        color: nodeColorForValue(normalizedValue, graphTokens),
      })
    }

    for (const attestation of attestations) {
      // const confidence = Number(attestation.decodedData?.confidence || 50)
      // const size =
      //   minEdgeSize +
      //   ((confidence - minConfidence) / (maxConfidence - minConfidence)) *
      //     (maxEdgeSize - minEdgeSize)
      graph.addEdgeWithKey(
        attestation.uid,
        attestation.attester.toLowerCase(),
        attestation.recipient.toLowerCase(),
        {
          href: `/attestations/${attestation.uid}`,
          label: attestation.decodedData?.confidence?.toString() || 'unknown',
          size: edgeSize,
        }
      )
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

    // Initialize force atlas 2 layout.
    new Promise<void>(async (resolve) => {
      const layout = new ForceAtlas2LayoutWorker(graph, {
        settings: {
          ...forceAtlas2.inferSettings(graph),
          ...forceAtlas2SettingsOverrides,
        },
      })

      layout.start()
      await new Promise<void>((resolve) =>
        setTimeout(resolve, forceAtlas2Duration)
      )
      layout.stop()
      layout.kill()

      setGraph(graph)
      setIsLoadingGraph(false)

      resolve()
    })
  }, [accountData, attestationsData, isTrustedSeed, ensData, graphTokens])

  const settling = isLoading || (isLoadingGraph && !graph)

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
      ) : error || !accountData || !attestationsData ? (
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
              : 'The first attestation in this network will draw the first edge.'}
          </p>
        </div>
      ) : (
        graph && (
          <SigmaContainer
            className={cn(
              'border border-border',
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
}: {
  title?: string
  graph: MultiDirectedGraph<NetworkGraphNode, NetworkGraphEdge>
  setShowCursor: (hovering: boolean) => void
  defaultLayout: 'circular' | 'forceatlas2'
  initialZoom?: number
  chrome?: boolean
}) => {
  const sigma = useSigma()
  const registerEvents = useRegisterEvents()
  const loadGraph = useLoadGraph()
  const setSettings = useSetSettings()
  const { reset: recenter } = useCamera()

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

  const tooltipRefs = useRef<{
    nodes: Record<string, HTMLDivElement>
    edges: Record<string, HTMLDivElement>
  }>({
    nodes: {},
    edges: {},
  })
  const nodeTooltipPaddingX = 10
  const nodeTooltipPaddingY = 16

  const getNodeTooltipPosition = useCallback(
    (node: string, attributes?: NetworkGraphNode) => {
      const { x, y, size } =
        attributes ?? sigma.getGraph().getNodeAttributes(node)
      const { x: viewportX, y: viewportY } = sigma.graphToViewport({ x, y })
      const { width: viewWidth } = sigma.getDimensions()
      const isOnRight = viewportX > viewWidth / 2
      return {
        // Use left for positioning if on the left side of the screen, and right if on the right side, so that the tooltip overflows the screen on the side it's on with its node. Just using the left position causes the tooltip to scrunch up against the right side of the screen in an unintuitive way.
        ...(isOnRight
          ? {
              left: 'unset',
              // Set the right position where the left edge should be, and then translate it to the right by the width of the tooltip (since it's dynamically sized, we can't subtract it from the right position).
              right: viewWidth - (viewportX + size / 2 + nodeTooltipPaddingX),
              transform: 'translateX(100%)',
            }
          : {
              left: viewportX + size / 2 + nodeTooltipPaddingX,
              right: 'unset',
              transform: 'translateX(0)',
            }),
        top: viewportY + size / 2 + nodeTooltipPaddingY,
      }
    },
    [sigma]
  )
  const getEdgeTooltipPosition = useCallback(
    (
      edge: string,
      sourceAttributes?: NetworkGraphNode,
      targetAttributes?: NetworkGraphNode
    ) => {
      const { x: sourceX, y: sourceY } =
        sourceAttributes ?? sigma.getGraph().getSourceAttributes(edge)
      const { x: targetX, y: targetY } =
        targetAttributes ?? sigma.getGraph().getTargetAttributes(edge)
      const x = (sourceX + targetX) / 2
      const y = (sourceY + targetY) / 2
      const { x: viewportX, y: viewportY } = sigma.graphToViewport({ x, y })
      // Get dimensions dynamically to handle fullscreen mode
      const { width: viewWidth } = sigma.getDimensions()
      const isOnRight = viewportX > viewWidth / 2
      return {
        // Use left for positioning if on the left side of the screen, and right if on the right side, so that the tooltip overflows the screen on the side it's on with its node. Just using the left position causes the tooltip to scrunch up against the right side of the screen in an unintuitive way.
        ...(isOnRight
          ? {
              left: 'unset',
              // Set the right position where the left edge should be, and then translate it to the right by the width of the tooltip (since it's dynamically sized, we can't subtract it from the right position).
              right: viewWidth - viewportX,
            }
          : {
              left: viewportX,
              right: 'unset',
            }),
        top: viewportY,
        transform: 'translateX(-50%) translateY(-50%)',
      }
    },
    [sigma]
  )

  const updateTooltipPositions = useCallback(() => {
    Object.entries(tooltipRefs.current.nodes).forEach(([node, el]) => {
      Object.entries(getNodeTooltipPosition(node)).forEach(([key, value]) => {
        el.style[key as 'left' | 'top' | 'right' | 'transform'] =
          typeof value === 'number' ? value + 'px' : value
      })
    })
    Object.entries(tooltipRefs.current.edges).forEach(([edge, el]) => {
      Object.entries(getEdgeTooltipPosition(edge)).forEach(([key, value]) => {
        el.style[key as 'left' | 'top' | 'right' | 'transform'] =
          typeof value === 'number' ? value + 'px' : value
      })
    })
  }, [getNodeTooltipPosition, getEdgeTooltipPosition])

  // Update tooltip positions when container dimensions change (resize, fullscreen)
  useEffect(() => {
    const handleResize = () => {
      // Use requestAnimationFrame to ensure Sigma.js has updated its dimensions
      requestAnimationFrame(() => {
        updateTooltipPositions()
      })
    }

    // Listen for resize events
    window.addEventListener('resize', handleResize)
    // Listen for fullscreen changes
    document.addEventListener('fullscreenchange', handleResize)
    document.addEventListener('webkitfullscreenchange', handleResize)
    document.addEventListener('mozfullscreenchange', handleResize)
    document.addEventListener('MSFullscreenChange', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      document.removeEventListener('fullscreenchange', handleResize)
      document.removeEventListener('webkitfullscreenchange', handleResize)
      document.removeEventListener('mozfullscreenchange', handleResize)
      document.removeEventListener('MSFullscreenChange', handleResize)
    }
  }, [updateTooltipPositions])

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
      onLayoutUpdate: updateTooltipPositions,
    })

    // Register event handlers
    manager.register(registerEvents)

    return () => manager.cleanup()
  }, [
    graph,
    loadGraph,
    registerEvents,
    setHoverState,
    setShowCursor,
    updateTooltipPositions,
  ])

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
            newData.color = readGraphTokens().dim
            newData.highlighted = false
            newData.label = ''
            // newData.hidden = true
          }
        }

        return newData
      },
      edgeReducer: (edge, data) => ({
        ...data,
        hidden: !!hoverState && !hoverState.edges.includes(edge),
      }),
    })
  }, [setSettings, sigma, hoverState, graph])

  return (
    <>
      {chrome && (
        <ControlsContainer position="top-left" className="flex flex-col">
          {title && (
            <div className="text-sm text-primary text-center pt-2 px-1 pb-1">
              {title}
            </div>
          )}

          <div className="flex flex-row justify-around">
            <ZoomControl />
            <FullScreenControl />

            {layout === 'circular' ? (
              <div className="react-sigma-control">
                <button title="Spread Out" onClick={setForceAtlas2Layout}>
                  <Waypoints width="1em" height="1em" />
                </button>
              </div>
            ) : (
              <div className="react-sigma-control">
                <button title="Round Out" onClick={setCircularLayout}>
                  <CircleDashed width="1em" height="1em" />
                </button>
              </div>
            )}
          </div>
        </ControlsContainer>
      )}

      {Array.from(graph.nodeEntries()).map(({ node, attributes }) => {
        const visible =
          !!hoverState &&
          // Only show node tooltips if hovering an edge (when hovering over a
          // node, there are too many, and it gets very cluttered).
          hoverState.type === 'edge' &&
          hoverState.nodes.includes(node)
        const style = getNodeTooltipPosition(node, attributes)

        return (
          <div
            ref={(el) => {
              if (el) {
                tooltipRefs.current.nodes[node] = el
              } else {
                delete tooltipRefs.current.nodes[node]
              }
            }}
            key={node}
            className={cn(
              'absolute flex flex-col items-center justify-center rounded-sm px-2 py-1 bg-primary/10 text-primary backdrop-blur-xs pointer-events-none transition-opacity duration-150',
              visible ? 'opacity-100' : 'opacity-0'
            )}
            style={style}
          >
            <p className="text-xs">
              Score: {formatBigNumber(attributes.value, 18)}
            </p>
          </div>
        )
      })}

      {Array.from(graph.edgeEntries()).map(
        ({ edge, attributes, sourceAttributes, targetAttributes }) => {
          const visible = !!hoverState && hoverState.edges.includes(edge)
          const style = getEdgeTooltipPosition(
            edge,
            sourceAttributes,
            targetAttributes
          )

          return (
            <div
              ref={(el) => {
                if (el) {
                  tooltipRefs.current.edges[edge] = el
                } else {
                  delete tooltipRefs.current.edges[edge]
                }
              }}
              key={edge}
              className={cn(
                'absolute flex flex-col items-center justify-center rounded-sm px-2 py-1 bg-primary/10 text-primary backdrop-blur-xs pointer-events-none transition-opacity duration-150',
                visible ? 'opacity-100' : 'opacity-0'
              )}
              style={style}
            >
              <p className="text-xs">{attributes.label}%</p>
            </div>
          )
        }
      )}
    </>
  )
}
