'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * Persist editable input only. Restoring must never restore authority or a simulation.
 * Key the containing form by its draft scope so changing scope resets editable state too.
 */
export function useBrowserDraft<T>({
  storageKey,
  value,
  parse,
  onRestore,
  meaningful,
  completed = false,
}: {
  storageKey: string
  value: T
  parse: (value: unknown) => T | null
  onRestore: (value: T) => void
  meaningful: boolean
  completed?: boolean
}) {
  const savedCurrent = useRef(false)
  const scope = useRef(storageKey)
  const sameScope = scope.current === storageKey
  const callbacks = useRef({ parse, onRestore })
  callbacks.current = { parse, onRestore }
  const [loaded, setLoaded] = useState<{ key: string; draft: T | null }>()
  const [status, setStatus] = useState('')
  const encoded = JSON.stringify(value)

  useEffect(() => {
    if (!sameScope) return
    let draft: T | null = null
    let message = ''
    try {
      const raw = localStorage.getItem(storageKey)
      if (raw) {
        const envelope = JSON.parse(raw)
        if (envelope?.version === 1)
          draft = callbacks.current.parse(envelope.value)
        if (!draft)
          message =
            'The saved draft could not be restored. You can start a new draft.'
      }
      setStatus(message)
    } catch {
      setStatus(
        'Draft storage is unavailable. Keep this tab open while you finish.'
      )
    }
    setLoaded({ key: storageKey, draft })
  }, [sameScope, storageKey])

  useEffect(() => {
    if (!sameScope || loaded?.key !== storageKey || loaded.draft || completed)
      return
    if (!meaningful) {
      if (!savedCurrent.current) return
      savedCurrent.current = false
      try {
        localStorage.removeItem(storageKey)
      } catch {
        /* Editing remains available. */
      }
      setStatus('')
      return
    }
    const save = () => {
      try {
        localStorage.setItem(
          storageKey,
          JSON.stringify({ version: 1, value: JSON.parse(encoded) })
        )
        savedCurrent.current = true
        setStatus('Draft saved in this browser')
      } catch {
        setStatus(
          'Could not save this draft. Keep this tab open while you finish.'
        )
      }
    }
    save()
  }, [completed, encoded, loaded, meaningful, sameScope, storageKey])

  useEffect(() => {
    if (!sameScope || !completed) return
    try {
      localStorage.removeItem(storageKey)
    } catch {
      /* Creation already succeeded. */
    }
    setStatus('')
  }, [completed, sameScope, storageKey])

  return {
    ready: sameScope && loaded?.key === storageKey,
    pending: loaded?.key === storageKey ? loaded.draft : null,
    status: sameScope
      ? status
      : 'This form changed scope. Reload the page before continuing.',
    restore: () => {
      if (!sameScope || loaded?.key !== storageKey || !loaded.draft) return
      savedCurrent.current = true
      callbacks.current.onRestore(loaded.draft)
      setLoaded({ key: storageKey, draft: null })
      setStatus('Draft restored. Review your choices before signing.')
    },
    discard: () => {
      if (!sameScope) return
      try {
        localStorage.removeItem(storageKey)
      } catch {
        /* Editing remains available. */
      }
      setLoaded({ key: storageKey, draft: null })
      setStatus('')
    },
  }
}
