'use client'

import { X } from 'lucide-react'
import { ReactNode, useEffect, useId, useRef } from 'react'

import { useUpdatingRef } from '@/hooks/useUpdatingRef'
import { cn } from '@/lib/utils'

import { Card } from './Card'

interface ModalProps {
  isOpen: boolean
  onClose?: () => void
  children: React.ReactNode
  title?: string
  className?: string
  contentClassName?: string
  footer?: ReactNode
  backgroundContent?: ReactNode
}

export function Modal({
  isOpen,
  onClose,
  children,
  title,
  className,
  contentClassName,
  footer,
  backgroundContent,
}: ModalProps) {
  const contentRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = useId()

  useEffect(() => {
    if (isOpen) {
      // Scroll to top of content on open.
      contentRef.current?.scrollTo({ top: 0, behavior: 'instant' })

      const scrollX = window.scrollX
      const scrollY = window.scrollY
      const width = document.documentElement.clientWidth
      document.body.style.position = 'fixed'
      document.body.style.top = `-${scrollY}px`
      document.body.style.left = `-${scrollX}px`
      document.body.style.width = `${width}px`
      return () => {
        document.body.style.position = ''
        document.body.style.top = ''
        document.body.style.left = ''
        document.body.style.width = ''
        window.scrollTo(scrollX, scrollY)
      }
    }
  }, [isOpen])

  const onCloseRef = useUpdatingRef(onClose)
  useEffect(() => {
    if (!isOpen) {
      return
    }

    const previouslyFocused = document.activeElement as HTMLElement | null
    const focusableSelector = [
      'a[href]',
      'button:not([disabled])',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',')
    const focusDialog = window.requestAnimationFrame(() => {
      const firstFocusable =
        dialogRef.current?.querySelector<HTMLElement>(focusableSelector)
      const focusTarget = firstFocusable ?? dialogRef.current
      focusTarget?.focus({ preventScroll: true })
    })

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseRef.current?.()
        return
      }
      if (e.key !== 'Tab' || !dialogRef.current) return

      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(focusableSelector)
      ).filter((element) => !element.hasAttribute('hidden'))
      if (focusable.length === 0) {
        e.preventDefault()
        dialogRef.current.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)

    return () => {
      window.cancelAnimationFrame(focusDialog)
      document.removeEventListener('keydown', handleKeyDown)
      previouslyFocused?.focus({ preventScroll: true })
    }
  }, [isOpen, onCloseRef])

  const openedOnce = useRef(isOpen)
  if (isOpen && !openedOnce.current) {
    openedOnce.current = true
  }

  // Prevent initial flash on page load by hiding until first open.
  if (!openedOnce.current) {
    return null
  }

  return (
    <div
      aria-hidden={!isOpen}
      inert={!isOpen}
      className={cn(
        'fixed inset-0 z-50 flex items-center justify-center duration-200 backdrop-blur-sm motion-reduce:animate-none motion-reduce:transition-none',
        isOpen
          ? 'animate-in fade-in-0'
          : 'animate-out fade-out-0 pointer-events-none'
      )}
    >
      {/* Backdrop */}
      <div
        className="tg-scrim fixed inset-0 cursor-pointer"
        onClick={
          onClose &&
          ((e) => {
            e.stopPropagation()
            onClose()
          })
        }
      />

      {/* Modal */}
      <Card
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : 'Dialog'}
        tabIndex={-1}
        type="popover"
        size="md"
        className={cn(
          'relative z-50 w-full max-w-md max-h-[90vh] mx-4 !p-0 flex flex-col overflow-hidden motion-reduce:animate-none motion-reduce:transition-none',
          isOpen ? 'animate-in zoom-in-95' : 'animate-out zoom-out-95',
          className
        )}
      >
        {onClose && (
          <button
            type="button"
            aria-label="Close dialog"
            onClick={onClose}
            className="absolute right-3 top-3 z-10 flex min-h-11 min-w-11 items-center justify-center text-muted-foreground transition-colors hover:text-muted-foreground/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink motion-reduce:transition-none"
          >
            <X size={20} />
          </button>
        )}

        {/* Header */}
        {title && (
          <div className="flex items-center justify-between border-b border-border p-4 pr-16 shrink-0">
            <h2 id={titleId} className="font-bold">
              {title}
            </h2>
          </div>
        )}

        {/* Content */}
        <div
          className={cn('p-4 overflow-y-auto grow min-h-0', contentClassName)}
          ref={contentRef}
        >
          {children}
        </div>

        {footer && (
          <div className="p-4 border-t border-border shrink-0">{footer}</div>
        )}
      </Card>

      {backgroundContent && (
        <div className="absolute inset-0 z-40 pointer-events-none">
          {backgroundContent}
        </div>
      )}
    </div>
  )
}
