'use client'

import { X } from 'lucide-react'
import { ReactNode, useEffect, useRef } from 'react'

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

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseRef.current?.()
      }
    }

    document.addEventListener('keydown', handleEscape)

    return () => {
      document.removeEventListener('keydown', handleEscape)
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
      className={cn(
        'fixed inset-0 z-50 flex items-center justify-center duration-200 backdrop-blur-sm',
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

      {onClose && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
          className="absolute top-6 right-6 text-muted-foreground hover:text-muted-foreground/80 transition-colors leading-none z-10"
        >
          <X size={20} />
        </button>
      )}

      {/* Modal */}
      <Card
        type="popover"
        size="md"
        className={cn(
          'relative z-50 w-full max-w-md max-h-[90vh] mx-4 !p-0 flex flex-col overflow-hidden',
          isOpen ? 'animate-in zoom-in-95' : 'animate-out zoom-out-95',
          className
        )}
      >
        {/* Header */}
        {title && (
          <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
            <h2 className="font-bold">{title}</h2>
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
