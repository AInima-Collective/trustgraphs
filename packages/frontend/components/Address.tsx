'use client'

import { ArrowUpRight, Check, Copy } from 'lucide-react'
import Link from 'next/link'
import React, { useState } from 'react'
import toast from 'react-hot-toast'
import { useAccount } from 'wagmi'

import { useEns } from '@/hooks/useEns'
import { usePushBreadcrumb } from '@/hooks/usePushBreadcrumb'
import { cn } from '@/lib/utils'

import { Tooltip } from './Tooltip'

interface AddressProps {
  address: string
  className?: string
  textClassName?: string
  /** Display mode for the address */
  displayMode?: 'full' | 'truncated' | 'auto'
  /** Whether to show ENS name if available */
  showEns?: boolean
  /** Custom display text (overrides ENS and address) */
  displayText?: string
  /** Whether to show navigation icon (always) */
  showNavIcon?: boolean
  /** Whether to show copy icon (on hover) */
  showCopyIcon?: boolean
  /** Link to page for the address. Defaults to account page. */
  link?: 'account' | false
  /** Whether to use monospace font */
  monospace?: boolean
  /** Whether to not highlight names that conceal the address */
  noHighlight?: boolean
  /** Whether to not highlight ENS names only */
  noHighlightEns?: boolean

  /** Custom tooltip content */
  tooltip?: string
}

export const Address = ({
  address,
  className = '',
  textClassName = '',
  displayMode = 'auto',
  showEns = true,
  displayText,
  showNavIcon = false,
  showCopyIcon = true,
  link = 'account',
  monospace = true,
  noHighlight = false,
  noHighlightEns = false,
  tooltip,
}: AddressProps) => {
  const pushBreadcrumb = usePushBreadcrumb()
  const { address: connectedAddress } = useAccount()

  const [copied, setCopied] = useState(false)

  const clickable = link !== false

  const isYou = connectedAddress?.toLowerCase() === address.toLowerCase()
  if (isYou && !displayText) {
    displayText = 'You'
  }

  const { name: ensName } = useEns(address, { enableName: showEns })

  const handleCopy = async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
      toast.success('Address copied to clipboard!')
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy address:', err)
      toast.error('Failed to copy address')
    }
  }

  // Determine what to display
  const getDisplayText = () => {
    if (displayText) return displayText
    if (ensName && showEns) return ensName
    return address
  }

  const getTruncatedText = (text: string) => {
    if (text.length <= 10) return text
    return `${text.slice(0, 6)}...${text.slice(-4)}`
  }

  const displayedText = getDisplayText()
  const truncatedText = getTruncatedText(displayedText)
  const isShowingEns = !!ensName && showEns && !displayText
  const shouldHighlight =
    !noHighlight && ((!noHighlightEns && isShowingEns) || isYou)
  const isLoading = false // Don't show loading state, just display address

  const baseClasses = cn(
    'group/address inline-flex items-center gap-2 transition-colors',
    monospace && !shouldHighlight && 'font-mono',
    clickable ? 'cursor-pointer' : 'cursor-default',
    className
  )

  const hoverClasses = cn(
    'transition-colors',
    shouldHighlight
      ? [
          'text-text',
          clickable &&
            'group-hover/address:text-text-muted peer-hover/copy:text-text!',
        ]
      : [
          'text-muted-foreground',
          clickable &&
            'group-hover/address:text-text peer-hover/copy:text-text-muted',
        ],
    textClassName
  )

  const textClasses = cn('break-all text-sm font-medium', hoverClasses)

  const copyIcon = copied ? (
    <Check className="w-3 h-3 text-success dark:text-success shrink-0" />
  ) : (
    <Copy className="h-3 w-3 shrink-0 transition-colors hover:text-text" />
  )

  const renderText = () => {
    switch (displayMode) {
      case 'full':
        return <span className={textClasses}>{displayedText}</span>
      case 'truncated':
        return <span className={textClasses}>{truncatedText}</span>
      case 'auto':
      default:
        return isShowingEns ? (
          <span className={textClasses}>{displayedText}</span>
        ) : (
          <>
            <span className={cn(textClasses, 'hidden md:inline')}>
              {displayedText}
            </span>
            <span className={cn(textClasses, 'md:hidden')}>
              {truncatedText}
            </span>
          </>
        )
    }
  }

  const content = (
    <>
      {renderText()}

      {showNavIcon && (
        <ArrowUpRight className={cn('-ml-1 w-3 h-3 shrink-0', hoverClasses)} />
      )}

      {/* Copy button */}
      {showCopyIcon && !isLoading && (
        <button
          onClick={handleCopy}
          className="opacity-0 group-hover/address:opacity-100 transition-opacity focus:opacity-100 focus:outline-none peer/copy"
          tabIndex={0}
          aria-label={`Copy address ${address}`}
          title={copied ? 'Copied!' : 'Copy address'}
        >
          {copyIcon}
        </button>
      )}
    </>
  )

  return (
    <Tooltip
      title={
        tooltip ||
        (isShowingEns
          ? `${address.slice(0, 10)}...${address.slice(-8)}`
          : undefined)
      }
    >
      {clickable ? (
        <Link
          className={baseClasses}
          onClick={(e) => {
            e.stopPropagation()
            pushBreadcrumb()
          }}
          href={link === 'account' ? `/account/${address}` : '#'}
        >
          {content}
        </Link>
      ) : (
        <div className={baseClasses}>{content}</div>
      )}
    </Tooltip>
  )
}

// Utility component for addresses in tables
export const TableAddress = React.memo(
  (props: Omit<AddressProps, 'displayMode' | 'className'>) => (
    <Address
      {...props}
      displayMode="auto"
      className="text-xs"
      monospace={true}
      noHighlightEns
    />
  )
)
