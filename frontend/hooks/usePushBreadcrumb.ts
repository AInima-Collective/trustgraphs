'use client'

import { useSetAtom } from 'jotai'
import { usePathname } from 'next/navigation'
import { useCallback } from 'react'

import { useNetworks } from '@/contexts/CatalogContext'
import { mightBeEnsName } from '@/lib/utils'
import { Breadcrumb, breadcrumbsAtom } from '@/state/nav'

/**
 * Returns a function to push a breadcrumb before navigating to a new page. If no breadcrumb is provided to the push function, one will be automatically generated based on the current path.
 */
export const usePushBreadcrumb = (defaultBreadcrumb?: Partial<Breadcrumb>) => {
  const pathname = usePathname()
  const setBreadcrumbs = useSetAtom(breadcrumbsAtom)
  // Runtime catalog, so a factory-created network gets its name in the trail like any other.
  const networks = useNetworks()

  return useCallback(
    (breadcrumb?: Partial<Breadcrumb>) => {
      const finalBreadcrumb: Breadcrumb = {
        title: '',
        route: pathname,
        ...defaultBreadcrumb,
        ...breadcrumb,
      }

      if (!finalBreadcrumb.title) {
        const lastSegment = pathname.split('/').pop()
        if (
          lastSegment &&
          pathname.startsWith('/networks/') &&
          networks.some((n) => n.id === lastSegment)
        ) {
          // Network name
          finalBreadcrumb.title = networks.find(
            (n) => n.id === lastSegment
          )!.name
        } else if (
          lastSegment &&
          pathname.startsWith('/account/') &&
          mightBeEnsName(lastSegment)
        ) {
          // ENS name
          finalBreadcrumb.title = lastSegment
        } else if (lastSegment === 'governance') {
          finalBreadcrumb.title = 'proposals'
        } else if (
          // Trailing slash ensures this is a specific resource page, not the list page
          pathname.startsWith('/account/') ||
          pathname.startsWith('/attestations/') ||
          // Should never happen...
          pathname.startsWith('/networks/')
        ) {
          // Resource type
          finalBreadcrumb.title = pathname.split('/')[1]!
        } else {
          finalBreadcrumb.title = 'previous page'
        }
      }

      setBreadcrumbs((b) => [...b, finalBreadcrumb])
    },
    // `defaultBreadcrumb` is intentionally out of the deps (call sites pass a fresh object every
    // render); `networks` is React Query data, stable until the catalog actually changes.
    [setBreadcrumbs, pathname, networks]
  )
}
