'use client'

import { HTMLMotionProps, motion } from 'motion/react'
import Link from 'next/link'
import ReactMarkdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'

import { cn } from '@/lib/utils'

export type MarkdownProps = {
  children: string
  className?: string
  rawHtml?: boolean
  textFade?: boolean
}

export const Markdown = ({
  children,
  className,
  textFade,
  rawHtml,
}: MarkdownProps) => {
  return (
    <div className={cn('flex flex-col gap-4 break-words text-left', className)}>
      <ReactMarkdown
        components={{
          ...(textFade ? { p: SlideFadeInParagraph as any } : {}),
          a: StyledLink as any,
        }}
        rehypePlugins={rawHtml ? [rehypeRaw] : undefined}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}

const SlideFadeInParagraph = ({
  children,
  className,
  ...props
}: HTMLMotionProps<'p'>) => (
  <motion.p
    initial={{ opacity: 0, y: 5 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ duration: 0.4, ease: 'easeOut' }}
    className={cn('whitespace-pre-wrap break-words', className)}
    {...props}
  >
    {children}
  </motion.p>
)

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
