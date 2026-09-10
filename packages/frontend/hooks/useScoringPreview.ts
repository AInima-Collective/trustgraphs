'use client'

import { useEffect, useState } from 'react'

import type { ScoringPreview, ScoringPreviewInput } from '@/lib/scoring-preview'

/** Each revision gets its own worker, so an obsolete calculation cannot authorize review. */
export function useScoringPreview(request: ScoringPreviewInput | undefined) {
  const [result, setResult] = useState<{
    request: ScoringPreviewInput
    preview?: ScoringPreview
    error?: string
  }>()

  useEffect(() => {
    if (!request) return
    let worker: Worker | undefined
    const timer = window.setTimeout(() => {
      try {
        worker = new Worker(
          new URL('../workers/scoring-preview.ts', import.meta.url)
        )
        worker.onmessage = (
          event: MessageEvent<{ preview?: ScoringPreview; error?: string }>
        ) => {
          setResult({ request, ...event.data })
          worker?.terminate()
        }
        worker.onerror = () => {
          setResult({
            request,
            error:
              'The scoring preview could not finish. Edit a setting to retry.',
          })
          worker?.terminate()
        }
        worker.postMessage(request)
      } catch {
        setResult({
          request,
          error:
            'Scoring previews are unavailable in this browser. Try a browser that supports web workers.',
        })
      }
    }, 150)
    return () => {
      window.clearTimeout(timer)
      worker?.terminate()
    }
  }, [request])

  const current = result?.request === request ? result : undefined
  return {
    preview: current?.preview,
    error: current?.error,
    pending: !!request && !current,
  }
}
