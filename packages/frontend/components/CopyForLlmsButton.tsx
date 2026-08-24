'use client'

import { Check, Copy } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/Button'

type CopyState = 'idle' | 'copied' | 'error'

const writeToClipboard = async (text: string) => {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Fall through for browsers that expose the API but deny it outside a
      // secure context (common on local network development URLs).
    }
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.readOnly = true
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  textarea.style.pointerEvents = 'none'
  document.body.appendChild(textarea)
  textarea.select()

  const copied = document.execCommand('copy')
  textarea.remove()
  if (!copied) throw new Error('Clipboard copy failed')
}

/** Copy a documentation page's original Markdown, ready to paste into a prompt. */
export function CopyForLlmsButton({ markdown }: { markdown: string }) {
  const [state, setState] = useState<CopyState>('idle')
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current)
    },
    []
  )

  const copy = async () => {
    try {
      await writeToClipboard(markdown)
      setState('copied')
    } catch {
      setState('error')
    }

    if (resetTimer.current) clearTimeout(resetTimer.current)
    resetTimer.current = setTimeout(() => setState('idle'), 2000)
  }

  const copied = state === 'copied'
  const label = copied
    ? 'Copied'
    : state === 'error'
      ? 'Copy failed'
      : 'Copy for LLMs'

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={copy}
      className="w-40 shrink-0"
      title="Copy the full page as Markdown"
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      <span aria-live="polite">{label}</span>
    </Button>
  )
}
