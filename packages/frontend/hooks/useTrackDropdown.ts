import { useCallback, useEffect, useRef, useState } from 'react'

import { useUpdatingRef } from './useUpdatingRef'

export type UseTrackDropdownOptions = {
  top?: (rect: DOMRect) => number
  left?: null | ((rect: DOMRect) => number)
  right?: null | ((rect: DOMRect) => number)
  width?: null | ((rect: DOMRect) => number)
  /** Minimum distance from the visible viewport edge. */
  padding?: number
  enabled?: boolean
}

/** Anchor a fixed panel to its trigger and keep it inside the visible viewport. */
export const useTrackDropdown = ({
  top,
  left,
  right = null,
  width,
  padding = 32,
  enabled = true,
}: UseTrackDropdownOptions = {}) => {
  const dropdownRef = useRef<HTMLDivElement | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [ready, setReady] = useState(0)

  const updateRect = () => {
    const panel = dropdownRef.current
    const trigger = trackRef.current
    if (!enabled || !panel || !trigger) return

    // visualViewport follows the on-screen keyboard and pinch zoom; innerHeight
    // alone can leave controls behind a mobile keyboard.
    const viewport = window.visualViewport
    const inset = Math.max(8, padding)
    const viewportLeft = viewport?.offsetLeft ?? 0
    const viewportTop = viewport?.offsetTop ?? 0
    const viewportWidth =
      viewport?.width ?? document.documentElement.clientWidth
    const viewportHeight = viewport?.height ?? window.innerHeight
    const minLeft = viewportLeft + inset
    const maxRight = viewportLeft + viewportWidth - inset
    const minTop = viewportTop + inset
    const maxBottom = viewportTop + viewportHeight - inset
    const rect = trigger.getBoundingClientRect()

    panel.style.left = ''
    panel.style.right = ''
    panel.style.bottom = ''
    panel.style.width = ''
    panel.style.maxWidth = `${Math.max(0, maxRight - minLeft)}px`
    // Keep the existing height constraint while measuring scrollHeight. Temporarily
    // expanding a scrollable panel would reset its scrollTop on every scroll event.

    const requestedLeft =
      left === null ? undefined : (left?.(rect) ?? rect.left)
    const requestedRight =
      right === null ? undefined : (right?.(rect) ?? rect.right)
    if (width !== null) {
      panel.style.width = `${width?.(rect) ?? rect.width}px`
    } else if (requestedLeft !== undefined && requestedRight !== undefined) {
      panel.style.width = `${Math.max(0, document.documentElement.clientWidth - requestedRight - requestedLeft)}px`
    }

    const panelWidth = panel.getBoundingClientRect().width
    const alignedLeft =
      requestedLeft ??
      document.documentElement.clientWidth - (requestedRight ?? 0) - panelWidth
    panel.style.left = `${Math.max(minLeft, Math.min(alignedLeft, maxRight - panelWidth))}px`

    const belowTop = Math.max(minTop, top?.(rect) ?? rect.bottom)
    const gap = Math.max(0, (top?.(rect) ?? rect.bottom) - rect.bottom)
    const aboveBottom = Math.min(maxBottom, rect.top - gap)
    const belowSpace = Math.max(0, maxBottom - belowTop)
    const aboveSpace = Math.max(0, aboveBottom - minTop)
    const naturalHeight =
      panel.scrollHeight + panel.offsetHeight - panel.clientHeight
    const above = naturalHeight > belowSpace && aboveSpace > belowSpace
    const available = above ? aboveSpace : belowSpace
    const height = Math.min(naturalHeight, available)

    panel.style.maxHeight = `${available}px`
    panel.style.top = `${above ? aboveBottom - height : Math.min(belowTop, maxBottom)}px`
    panel.dataset.side = above ? 'top' : 'bottom'
  }

  const updateRectRef = useUpdatingRef(updateRect)

  useEffect(() => {
    if (!enabled) return
    let frame = 0
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => updateRectRef.current())
    }
    schedule()
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    const viewport = window.visualViewport
    viewport?.addEventListener('resize', schedule)
    viewport?.addEventListener('scroll', schedule)

    const observer = new ResizeObserver(schedule)
    if (trackRef.current) observer.observe(trackRef.current)
    if (dropdownRef.current) observer.observe(dropdownRef.current)
    const contentObserver = new MutationObserver(schedule)
    if (dropdownRef.current) {
      contentObserver.observe(dropdownRef.current, {
        childList: true,
        subtree: true,
        characterData: true,
      })
    }

    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      viewport?.removeEventListener('resize', schedule)
      viewport?.removeEventListener('scroll', schedule)
      observer.disconnect()
      contentObserver.disconnect()
    }
  }, [enabled, ready, updateRectRef])

  const onDropdownRef = useCallback((element: HTMLDivElement | null) => {
    if (dropdownRef.current === element) return
    dropdownRef.current = element
    if (element) setReady((value) => value + 1)
  }, [])
  const onTrackRef = useCallback((element: HTMLDivElement | null) => {
    if (trackRef.current === element) return
    trackRef.current = element
    if (element) setReady((value) => value + 1)
  }, [])

  return { onDropdownRef, onTrackRef, updateRectRef }
}
