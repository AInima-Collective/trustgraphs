'use client'

import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import toast from 'react-hot-toast'

import { cn } from '@/lib/utils'

interface CopyableTextProps {
  text: string
  displayText?: string
  className?: string
  truncate?: boolean
  truncateEnds?: [number, number]
  truncateOnMobile?: boolean
  alwaysShowCopyIcon?: boolean
}

export function CopyableText({
  text,
  displayText,
  className = '',
  truncate = false,
  truncateOnMobile = true,
  truncateEnds = [6, 4],
  alwaysShowCopyIcon = false,
}: CopyableTextProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation() // Prevent parent click handlers
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Could not copy to clipboard')
    }
  }

  const display = displayText || text
  const truncatedDisplay = `${display.slice(
    0,
    truncateEnds[0]
  )}...${display.slice(-truncateEnds[1])}`

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        'tg-touch-target group inline-flex min-h-6 items-center gap-2 font-mono text-xs hover:text-foreground transition-colors text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink',
        className
      )}
      title="Click to copy"
    >
      {truncate ? (
        <span className="break-all">{truncatedDisplay}</span>
      ) : truncateOnMobile ? (
        <>
          <span className="hidden md:inline break-all">{display}</span>
          <span className="md:hidden break-all">{truncatedDisplay}</span>
        </>
      ) : (
        <span className="break-all">{display}</span>
      )}
      {copied ? (
        <Check className="w-3 h-3 text-success flex-shrink-0" />
      ) : (
        <Copy
          className={cn(
            'w-3 h-3 transition-opacity flex-shrink-0',
            !alwaysShowCopyIcon &&
              'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100'
          )}
        />
      )}
    </button>
  )
}
