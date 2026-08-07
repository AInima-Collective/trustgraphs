import { EventHandlers } from '@react-sigma/core'
import { MultiDirectedGraph } from 'graphology'

import { NetworkGraphEdge, NetworkGraphNode } from '@/lib/types'

export type NetworkGraphTargetType = 'node' | 'edge'

export type NetworkGraphHoverState = {
  type: NetworkGraphTargetType
  touch?: 'first' | 'second'
  target: string
  nodes: string[]
  edges: string[]
} | null

export type NetworkGraphDragState = 'IDLE' | 'DRAG_START' | 'DRAGGING'

export type NetworkGraphInputType = 'mouse' | 'touch'

export type NetworkGraphHoverConfig = {
  alwaysHoverNode?: string
  hoverDelay: number
  unhoverDelay: number
}

export type NetworkGraphInternalState =
  | 'IDLE'
  | 'PREPARING_HOVER'
  | 'HOVERING'
  | 'PREPARING_UNHOVER'

export class NetworkGraphManager {
  private graph: MultiDirectedGraph<NetworkGraphNode, NetworkGraphEdge>
  private config: NetworkGraphHoverConfig
  private onStateChange: (
    state: NetworkGraphHoverState,
    showCursor: boolean
  ) => void
  private onLayoutUpdate: () => void

  private state: NetworkGraphInternalState = 'IDLE'
  private hoverState: NetworkGraphHoverState | null = null
  private timeout: NodeJS.Timeout | null = null

  private dragState: NetworkGraphDragState = 'IDLE'
  private inputType: NetworkGraphInputType = 'mouse'

  constructor({
    graph,
    onStateChange,
    onLayoutUpdate,
    ...config
  }: {
    graph: MultiDirectedGraph<NetworkGraphNode, NetworkGraphEdge>
    onStateChange: (state: NetworkGraphHoverState, showCursor: boolean) => void
    onLayoutUpdate: () => void
  } & NetworkGraphHoverConfig) {
    this.graph = graph
    this.config = config
    this.onStateChange = onStateChange
    this.onLayoutUpdate = onLayoutUpdate
  }

  // Public API - called by event handlers

  register(
    registerEvents: (eventHandlers: Partial<EventHandlers>) => void
  ): void {
    registerEvents({
      ...(!this.config.alwaysHoverNode
        ? {
            enterNode: ({ node }) => this.hover('node', node),
            enterEdge: ({ edge }) => this.hover('edge', edge),
            leaveNode: ({ node }) => this.unhover('node', node),
            leaveEdge: ({ edge }) => this.unhover('edge', edge),
          }
        : {}),

      clickNode: ({ node }) => this.click('node', node),
      clickEdge: ({ edge }) => this.click('edge', edge),
      mousedown: () => {
        this.inputType = 'mouse'
        this.dragStart()
      },
      touchdown: () => {
        this.inputType = 'touch'
        this.dragStart()
      },
      mouseup: () => this.dragEnd(),
      touchup: () => this.dragEnd(),
      mousemovebody: () => this.maybeDragMove(),
      touchmovebody: () => this.maybeDragMove(),
      afterRender: () => this.onLayoutUpdate(),
    })

    if (this.config.alwaysHoverNode) {
      this.setHover('node', this.config.alwaysHoverNode, true)
    }
  }

  hover(type: NetworkGraphTargetType, target: string): void {
    // Don't change hover state if we're dragging
    if (this.isDragging()) {
      return
    }

    this.setHover(type, target)
  }

  unhover(type: NetworkGraphTargetType, target: string): void {
    // Don't unhover if we're dragging
    if (this.isDragging()) {
      return
    }

    // Only unhover if we're hovering the target or about to be hovering.
    if (
      this.isHoveringOrPreparingTo() &&
      // hoverState is null during PREPARING_HOVER, but we should still allow unhovering
      (!this.hoverState || this.isCurrentTarget(type, target))
    ) {
      this.clearPendingTransition()

      // Schedule transition to IDLE with unhover delay
      this.state = 'PREPARING_UNHOVER'
      this.timeout = setTimeout(() => {
        this.state = 'IDLE'
        this.notifyChange(null)
      }, this.config.unhoverDelay)
    }
  }

  click(type: NetworkGraphTargetType, target: string): void {
    // Check if clicked target is already visible in the hover state
    if (
      this.hoverState &&
      (type === 'node'
        ? this.hoverState?.nodes.includes(target)
        : this.hoverState?.edges.includes(target))
    ) {
      // The first touch selects and explains an item; the second follows it.
      // This also covers browsers that synthesize an enter event before click.
      if (this.inputType === 'touch') {
        if (this.hoverState.touch !== 'first') {
          this.notifyChange({ ...this.hoverState, touch: 'first' })
          return
        }
        this.hoverState.touch = 'second'
      }

      const href =
        type === 'node'
          ? this.graph.getNodeAttribute(target, 'href')
          : this.graph.getEdgeAttribute(target, 'href')

      if (href) {
        // Open in new tab
        window.open(href, '_blank')
      }
    } else {
      // Not hovering yet, begin hovering immediately
      this.setHover(
        type,
        target,
        true,
        this.inputType === 'touch' ? 'first' : undefined
      )
    }
  }

  dragStart(): void {
    this.dragState = 'DRAG_START'
  }

  dragEnd(): void {
    this.dragState = 'IDLE'
  }

  maybeDragMove(): void {
    if (this.dragState === 'IDLE') {
      return
    }
    this.dragState = 'DRAGGING'
    this.onLayoutUpdate()
  }

  cleanup(): void {
    this.clearPendingTransition()
  }

  // Internal methods

  private setHover(
    type: NetworkGraphTargetType,
    target: string,
    forceImmediate?: boolean,
    touch?: 'first' | 'second'
  ): void {
    this.clearPendingTransition()

    const newState: NetworkGraphHoverState = {
      type,
      target,
      ...(touch ? { touch } : {}),
      nodes:
        type === 'node'
          ? [...new Set([target, ...this.graph.neighbors(target)])]
          : this.graph.extremities(target),
      edges: type === 'node' ? this.graph.edges(target) : [target],
    }

    // Hover immediately if we're already hovering or if forceImmediate is true.
    if (forceImmediate ?? this.isHovering()) {
      this.state = 'HOVERING'
      this.notifyChange(newState)
    } else {
      // Prepare to hover
      this.state = 'PREPARING_HOVER'
      this.notifyChange(null)

      // Schedule hover
      this.timeout = setTimeout(() => {
        this.state = 'HOVERING'
        this.notifyChange(newState)
      }, this.config.hoverDelay)
    }
  }

  private clearPendingTransition(): void {
    if (this.timeout) {
      clearTimeout(this.timeout)
      this.timeout = null
    }
  }

  private isCurrentTarget(
    type: NetworkGraphTargetType,
    target: string
  ): boolean {
    return (
      !!this.hoverState &&
      this.hoverState.type === type &&
      this.hoverState.target === target
    )
  }

  private isHovering(): boolean {
    return this.state === 'HOVERING' || this.state === 'PREPARING_UNHOVER'
  }

  private isHoveringOrPreparingTo(): boolean {
    return this.isHovering() || this.state === 'PREPARING_HOVER'
  }

  private isDragging(): boolean {
    return this.dragState === 'DRAGGING'
  }

  private notifyChange(state: NetworkGraphHoverState): void {
    this.hoverState = state
    const showCursor = this.state !== 'IDLE'
    this.onStateChange(state, showCursor)
  }
}
