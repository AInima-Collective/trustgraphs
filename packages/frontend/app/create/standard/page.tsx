import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { isSubnetworkFeatureAvailable } from '@/lib/config'

import { CreateNetworkWizard } from '../component'
import { isFactoryAvailable } from '../model'

export const metadata: Metadata = {
  title: 'Create a standard network',
  description:
    'Create a standard trust network where members vouch for each other and starting accounts begin equally.',
}

export default async function CreateStandardNetworkPage({
  searchParams,
}: {
  searchParams: Promise<{ parent?: string; parentRoute?: string }>
}) {
  if (!isFactoryAvailable()) redirect('/create')
  const { parent, parentRoute } = await searchParams
  const parentInstanceId =
    isSubnetworkFeatureAvailable() && /^0x[0-9a-fA-F]{64}$/.test(parent ?? '')
      ? (parent as `0x${string}`)
      : undefined
  const parentNetworkId =
    parentInstanceId && /^[a-zA-Z0-9_-]+$/.test(parentRoute ?? '')
      ? parentRoute
      : parentInstanceId
  return (
    <CreateNetworkWizard
      parentInstanceId={parentInstanceId}
      parentNetworkId={parentNetworkId}
    />
  )
}
