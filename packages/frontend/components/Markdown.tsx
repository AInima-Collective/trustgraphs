'use client'

import Link from 'next/link'
import ReactMarkdown from 'react-markdown'

import { cn } from '@/lib/utils'

export type MarkdownProps = {
  children: string
  className?: string
}

export const Markdown = ({ children, className }: MarkdownProps) => {
  return (
    <div className={cn('flex flex-col gap-4 break-words text-left', className)}>
      <ReactMarkdown
        components={{
          a: StyledLink as any,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}

const StyledLink = ({
  href,
  children,
}: {
  href: string
  children: React.ReactNode
}) => {
  const isRemote = href.startsWith('http')
  return (
    <Link
      href={href}
      target={isRemote ? '_blank' : undefined}
      rel={isRemote ? 'noopener noreferrer' : undefined}
      className="underline transition-opacity hover:opacity-80 active:opacity-70"
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </Link>
  )
}
