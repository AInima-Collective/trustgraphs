import { useAtomValue } from 'jotai'
import { ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { cn } from '@/lib/utils'
import { Breadcrumb, breadcrumbsAtom } from '@/state/nav'

export type BreadcrumbRendererProps = {
  /** Breadcrumb to use if no breadcrumbs are set. */
  fallback?: Breadcrumb
  /** Class name to apply to the link. */
  className?: string
}

/**
 * Renders the breadcrumb trail for the current page.
 *
 * Breadcrumb removal on route change is handled in the BreadcrumbSync component.
 *
 * @param fallback - The fallback breadcrumb to use if no breadcrumbs are set.
 * @param className - The class name to apply to the link.
 * @returns The breadcrumb trail for the current page.
 */
export const BreadcrumbRenderer = ({
  fallback,
  className,
}: BreadcrumbRendererProps) => {
  const pathname = usePathname()

  const breadcrumbs = useAtomValue(breadcrumbsAtom)
  const breadcrumb =
    // If the last breadcrumb is not the current page, use it.
    (breadcrumbs[breadcrumbs.length - 1]?.route !== pathname
      ? breadcrumbs[breadcrumbs.length - 1]
      : // Otherwise, use the second to last breadcrumb. This prevents flickering when a breadcrumb is pushed for the current page just before the navigation occurs.
        breadcrumbs[breadcrumbs.length - 2]) || fallback

  if (!breadcrumb) {
    return null
  }

  return (
    <Link
      href={breadcrumb.route}
      className={cn(
        'flex items-center gap-2 text-sm text-text-muted transition-colors hover:text-text',
        className
      )}
    >
      <ArrowLeft className="w-4 h-4" />
      Back to {breadcrumb.title}
    </Link>
  )
}
