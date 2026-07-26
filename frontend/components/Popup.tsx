'use client'

import { usePathname } from 'next/navigation'
import {
  ComponentType,
  Dispatch,
  ReactNode,
  RefObject,
  SetStateAction,
  useEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'

import { useTrackDropdown } from '@/hooks/useTrackDropdown'
import { cn } from '@/lib/utils'

import { Card } from './Card'

export interface PopupProps {
  trigger: PopupTrigger
  position: 'left' | 'right' | 'wide' | 'same'
  children: ReactNode | ReactNode[]
  wrapperClassName?: string
  popupClassName?: string
  getKeydownEventListener?: (
    open: boolean,
    setOpen: Dispatch<SetStateAction<boolean>>
  ) => (event: KeyboardEvent) => any
  headerContent?: ReactNode
  onOpen?: () => void
  onClose?: () => void
  // Give parent a way to access and control open and setOpen.
  openRef?: RefObject<boolean | null>
  setOpenRef?: RefObject<Dispatch<SetStateAction<boolean>> | null>
  /**
   * Optionally add offset to the top of the popup.
   */
  topOffset?: number
  /**
   * Offset to add to the left/right side calculation.
   */
  sideOffset?: number
  /**
   * Optionally override the default padding of the popup.
   */
  popupPadding?: number
}

export type PopupTriggerOptions = {
  open: boolean
  onClick: () => void
}

export type PopupTriggerCustomComponent = ComponentType<{
  onClick: () => void
  open: boolean
}>

export type PopupTrigger =
  | {
      type: 'custom'
      Renderer: PopupTriggerCustomComponent
    }
  | {
      type: 'manual'
      open: boolean
      setOpen: Dispatch<SetStateAction<boolean>>
    }

export const Popup = ({
  trigger,
  position,
  children,
  wrapperClassName,
  popupClassName,
  getKeydownEventListener,
  headerContent,
  onOpen,
  onClose,
  openRef,
  setOpenRef,
  topOffset = 0,
  sideOffset = 0,
  popupPadding,
}: PopupProps) => {
  const wrapperRef = useRef<HTMLDivElement | null>(null)

  const [_open, _setOpen] = useState(false)
  const open = trigger.type === 'manual' ? trigger.open : _open
  const setOpen = trigger.type === 'manual' ? trigger.setOpen : _setOpen

  // The portal is gated on a mounted flag rather than on `typeof document`.
  // A `typeof document !== 'undefined'` branch renders nothing on the server
  // and a whole subtree on the very first client render, which is a hydration
  // mismatch by construction. React tolerated it while the portal happened to
  // be the last child of the nav — a trailing extra node is cheap to patch —
  // but the moment anything rendered after it (the theme toggle), the child
  // lists diverged mid-run and the whole nav got thrown away and rebuilt.
  // `mounted` starts false on both sides, so the first render agrees.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  // On route change, close the popup.
  const pathname = usePathname()
  useEffect(() => {
    setOpen(false)
  }, [pathname, setOpen])

  // Store open and setOpen in ref so parent can access them.
  useEffect(() => {
    if (openRef) {
      openRef.current = open
    }
    if (setOpenRef) {
      setOpenRef.current = setOpen
    }
    // Remove refs on unmount.
    return () => {
      if (openRef) {
        openRef.current = null
      }
      if (setOpenRef) {
        setOpenRef.current = null
      }
    }
  }, [open, openRef, setOpen, setOpenRef])

  // Trigger open callbacks.
  useEffect(() => {
    if (open) {
      onOpen?.()
    } else {
      onClose?.()
    }
  }, [onClose, onOpen, open])

  // Close popup on escape if open.
  useEffect(() => {
    if (!open) {
      return
    }

    const handleKeyPress = (event: KeyboardEvent) =>
      event.key === 'Escape' && setOpen(false)

    // Attach event listener.
    document.addEventListener('keydown', handleKeyPress)
    // Clean up event listener.
    return () => document.removeEventListener('keydown', handleKeyPress)
  }, [open, setOpen])

  const dropdownRef = useRef<HTMLDivElement | null>(null)

  // Listen for click not in bounds, and close if so. Adds listener only when
  // the dropdown is open.
  useEffect(() => {
    // Don't do anything if not on browser or popup is not open.
    // If open is switched off, the useEffect will remove the listener and then
    // not-readd it.
    if (typeof window === 'undefined' || !open) {
      return
    }

    const closeIfClickOutside = (event: MouseEvent) => {
      if (!(event.target instanceof Node)) {
        return
      }

      // If clicked on an element that is not a descendant of the popup
      // wrapper or the dropdown, close it.
      if (
        (!wrapperRef.current?.contains(event.target) ||
          wrapperRef.current === event.target) &&
        !dropdownRef.current?.contains(event.target)
      ) {
        setOpen(false)
      }
    }

    window.addEventListener('click', closeIfClickOutside)
    return () => window.removeEventListener('click', closeIfClickOutside)
  }, [open, setOpen])

  // Apply keydown event listener.
  useEffect(() => {
    if (!getKeydownEventListener) {
      return
    }

    const listener = getKeydownEventListener(open, setOpen)

    document.addEventListener('keydown', listener)
    // Clean up event listener on unmount.
    return () => document.removeEventListener('keydown', listener)
  }, [getKeydownEventListener, open, setOpen])

  // Track button to position the dropdown.
  const { onDropdownRef, onTrackRef, updateRectRef } = useTrackDropdown({
    // Some space between trigger and dropdown
    top: (rect) => rect.bottom + 4 + topOffset,
    left:
      position === 'right' || position === 'same'
        ? (rect) => rect.left + sideOffset
        : position === 'wide'
          ? () => 24
          : null,
    right:
      position === 'left' || position === 'same'
        ? // Use document client width instead of window inner width to account for scrollbar.
          (rect) =>
            document.documentElement.clientWidth - rect.right + sideOffset
        : position === 'wide'
          ? () => 24
          : null,
    width: null,
    padding: popupPadding,
  })

  // Update rect whenever position, popupPadding, or sideOffset changes.
  useEffect(() => {
    updateRectRef.current()
  }, [position, popupPadding, sideOffset, updateRectRef])

  // Prevent initial flash on page load by hiding until first open.
  const openedOnce = useRef(open)
  if (open && !openedOnce.current) {
    openedOnce.current = true
  }

  return (
    <>
      <div
        className={cn('inline-block', wrapperClassName)}
        ref={(ref) => {
          wrapperRef.current = ref
          onTrackRef(ref)
        }}
      >
        <TriggerRenderer
          options={{ open, onClick: () => setOpen((o) => !o) }}
          trigger={trigger}
        />
      </div>

      {/* Popup */}
      {mounted &&
        createPortal(
          <Card
            type="popover"
            size="md"
            className={cn(
              'fixed z-50 flex flex-col overflow-hidden! border border-hairline-strong transition-all',
              // Prevent initial flash on page load by hiding until first open.
              !openedOnce.current && 'hidden',
              // Open.
              open
                ? 'animate-in fade-in-0 zoom-in-95'
                : 'animate-out fade-out-0 zoom-out-95 pointer-events-none',
              popupClassName
            )}
            ref={(ref) => {
              dropdownRef.current = ref
              onDropdownRef(ref)
            }}
          >
            {headerContent && (
              <div className="mb-4 border-b border-border-base">
                <div className="p-4">{headerContent}</div>
              </div>
            )}

            {children}
          </Card>,
          document.body
        )}
    </>
  )
}

export type TriggerRendererProps = {
  trigger: PopupTrigger
  options: PopupTriggerOptions
}

export const TriggerRenderer = ({ trigger, options }: TriggerRendererProps) => (
  <>{trigger.type === 'custom' ? <trigger.Renderer {...options} /> : null}</>
)
