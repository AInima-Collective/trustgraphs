'use client'

import Link from 'next/link'

import { WalletConnectionButton } from '@/components/WalletConnectionButton'

import { ButtonLink } from './Button'
import Logo from './Logo'

// const menuItems: {
//   label: string
//   href: string
//   Icon?: ComponentType<{ className?: string }>
//   iconClassName?: string
// }[] = [
//   {
//     label: 'Attestations',
//     href: '/attestations',
//   },
//   {
//     label: 'Governance',
//     href: '/governance',
//   },
//   {
//     label: 'Network',
//     href: '/account',
//   },
// ]

export const Nav = () => {
  return (
    <nav className="flex flex-row justify-between items-center pb-3 sm:pb-4 md:pb-6 border-b border-border">
      <Link href="/">
        <Logo className="w-8 h-8 sm:w-10 sm:h-10" />
      </Link>

      <div className="flex flex-row gap-2 sm:gap-3 items-stretch">
        <ButtonLink href="/create" variant="ghost">
          <span className="hidden sm:block">Create a </span>
          Network
        </ButtonLink>

        <ButtonLink
          href="/support"
          target="_blank"
          variant="outline"
          rel="noopener noreferrer"
        >
          <span className="hidden sm:block">Contact </span>
          Support
        </ButtonLink>

        <WalletConnectionButton />
      </div>

      {/* <div className="flex justify-center items-stretch gap-4 sm:gap-6 text-foreground rounded-full bg-card border border-border transition-[background-color,box-shadow] hover:shadow-md px-4 sm:px-6 text-base h-10 sm:h-12">
        {menuItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={clsx(
              'transition-opacity hover:opacity-80 active:opacity-70 flex items-center gap-2',
              // If home and none are selected, make all items active.
              pathname === '/' || pathname === item.href
                ? 'opacity-100'
                : 'opacity-50'
            )}
          >
            {item.Icon && <item.Icon className={item.iconClassName} />}
            <span className="hidden md:block">{item.label}</span>
          </Link>
        ))}
      </div>

      <WalletConnectionButton className="justify-self-end" /> */}
    </nav>
  )
}
