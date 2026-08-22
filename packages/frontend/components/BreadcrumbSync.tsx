import { useSetAtom } from 'jotai'
import { usePathname } from 'next/navigation'
import { useEffect, useRef } from 'react'

import { breadcrumbsAtom } from '@/state/nav'

/**
 * Syncs the breadcrumbs when the browser history changes.
 *
 * Logic:
 * - If navigating TO the last breadcrumb's route → Pop that breadcrumb
 * - If navigating FROM the last breadcrumb's route → Keep it (forward navigation)
 * - Otherwise → Clear all breadcrumbs (unrelated navigation)
 */
export const BreadcrumbSync = () => {
  const pathname = usePathname()
  const prevPathname = useRef(pathname)

  const setBreadcrumbs = useSetAtom(breadcrumbsAtom)

  useEffect(() => {
    // Skip if no pathname or initial render
    if (!pathname || prevPathname.current === pathname) {
      return
    }

    setBreadcrumbs((prev) => {
      const lastBreadcrumb = prev[prev.length - 1]
      // No breadcrumb - nothing to do
      if (!lastBreadcrumb) {
        return prev
      }

      if (pathname === lastBreadcrumb.route) {
        // Navigated back to last breadcrumb - pop it
        return prev.slice(0, -1)
      } else if (prevPathname.current === lastBreadcrumb.route) {
        // Just pushed breadcrumb and navigating forward - keep it
        return prev
      } else {
        // Navigated elsewhere - clear all breadcrumbs
        return []
      }
    })

    prevPathname.current = pathname
  }, [pathname, setBreadcrumbs])

  return null
}
