'use client'

import { type ReactNode, createContext, useContext } from 'react'

import {
  type GovernanceComposerData,
  useGovernanceComposerData,
} from '@/hooks/useGovernanceComposerData'
import type { GovernanceActionDraft } from '@/lib/actions'

const GovernanceComposerContext = createContext<GovernanceComposerData | null>(
  null
)

/** Supplies live network data to every typed field inside the proposal composer. */
export function GovernanceComposerProvider({
  drafts,
  children,
}: {
  drafts: readonly GovernanceActionDraft[]
  children: ReactNode
}) {
  const data = useGovernanceComposerData(drafts)
  return (
    <GovernanceComposerContext.Provider value={data}>
      {children}
    </GovernanceComposerContext.Provider>
  )
}

/** Null outside the composer, so fields degrade to plain inputs when rendered elsewhere. */
export const useGovernanceComposer = () => useContext(GovernanceComposerContext)
