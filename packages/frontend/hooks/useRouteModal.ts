'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useCallback } from 'react'

/**
 * The app-wide route-with-modal convention: a `?key=1` search param drives the
 * house `Modal`, so a modal is linkable, survives refresh (reopening over its
 * page), and closes on the back button — without intercepting-route
 * boilerplate.
 *
 * `open` pushes (adds a history entry so back closes the modal); `close`
 * replaces (removes the param without stacking a second entry).
 */
export function useRouteModal(key: string) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const isOpen = searchParams.get(key) === '1'

  const open = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString())
    params.set(key, '1')
    router.push(`${pathname}?${params.toString()}`, { scroll: false })
  }, [router, pathname, searchParams, key])

  const close = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString())
    params.delete(key)
    const query = params.toString()
    router.replace(query ? `${pathname}?${query}` : pathname, {
      scroll: false,
    })
  }, [router, pathname, searchParams, key])

  return { isOpen, open, close }
}
