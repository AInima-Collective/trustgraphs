'use client'

import { AlertTriangle, CheckCircle2, GitFork } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import {
  type Address,
  type Hex,
  decodeEventLog,
  encodeFunctionData,
  isHex,
  keccak256,
  stringToHex,
  zeroAddress,
} from 'viem'
import { useReadContract } from 'wagmi'

import { Button, ButtonLink } from '@/components/Button'
import { Card } from '@/components/Card'
import { Input } from '@/components/Input'
import { NetworkHeader } from '@/components/NetworkHeader'
import { SectionHeading } from '@/components/SectionHeading'
import { useNetwork } from '@/contexts/NetworkContext'
import { useSubnetworkChildren } from '@/hooks/useSubnetworks'
import { SUBNETWORK_CONFIG } from '@/lib/config'
import {
  type GovernancePrefillAction,
  saveGovernancePrefill,
} from '@/lib/governance-prefill'
import {
  type SubnetworkRelationship,
  parentAuthorityModuleDeployerAbi,
  parentAuthorityModuleWriteAbi,
  recoveryProposerWriteAbi,
  safeModuleWriteAbi,
  subnetworkRegistryReadAbi,
  subnetworkRegistryWriteAbi,
} from '@/lib/subnetwork'
import { txToast } from '@/lib/tx'
import { cn } from '@/lib/utils'

type AdoptionTier = 'admin' | 'guardian' | 'label'

const adoptionTiers = [
  ['admin', 'Admin', 'Enable an instant parent module on this network Safe.'],
  [
    'guardian',
    'Guardian',
    'Make the parent the proposer on this network’s delayed recovery route.',
  ],
  ['label', 'Label only', 'Record the relationship without granting power.'],
] as const satisfies readonly (readonly [AdoptionTier, string, string])[]

const SubnetworkCard = ({
  link,
  onRelease,
}: {
  link: SubnetworkRelationship
  onRelease: () => void
}) => (
  <Card type="outline" size="md" className="space-y-3">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <Link
          href={`/networks/${link.child?.id ?? ''}`}
          className="font-medium underline-offset-4 hover:underline"
        >
          {link.child?.name ?? link.child?.id ?? 'Unknown child'}
        </Link>
        <p className="mt-1 text-xs capitalize text-muted-foreground">
          {link.power.tier} tier
        </p>
      </div>
      <span
        className={
          link.power.verified
            ? 'inline-flex items-center gap-1 text-xs text-success'
            : 'inline-flex items-center gap-1 text-xs text-error'
        }
      >
        {link.power.verified ? (
          <CheckCircle2 className="h-3.5 w-3.5" />
        ) : (
          <AlertTriangle className="h-3.5 w-3.5" />
        )}
        {link.power.verified ? 'Power verified' : 'Power not verified'}
      </span>
    </div>
    <p className="text-xs text-muted-foreground">
      {link.power.instruments.length
        ? `Observed through ${link.power.instruments.join(', ')}.`
        : 'The registry link remains active, but no current parent power instrument was observed.'}
    </p>
    <Button type="button" variant="ghost" size="sm" onClick={onRelease}>
      Prepare release proposal
    </Button>
  </Card>
)

export const SubnetworksPage = () => {
  const router = useRouter()
  const { network } = useNetwork()
  const parentId = network.instanceId!
  const { data: children = [], isLoading } = useSubnetworkChildren(parentId)
  const { data: pending = [] } = useSubnetworkChildren(parentId, 'pending')
  const [proposedParent, setProposedParent] = useState('')
  const [adoptionTier, setAdoptionTier] = useState<AdoptionTier | null>(null)
  const [moduleDeployment, setModuleDeployment] = useState<{
    address: Address
    parentId: Hex
  } | null>(null)
  const [deployingModule, setDeployingModule] = useState(false)
  const [adoptionFailure, setAdoptionFailure] = useState<string | null>(null)
  const registry = SUBNETWORK_CONFIG?.registry
  const parentModuleDeployer = SUBNETWORK_CONFIG?.parentModuleDeployer
  const childSafe = network.contracts.safe?.proxy
  const recoveryModule = network.contracts.safe?.recoveryModule
  const parentIdValid =
    isHex(proposedParent, { strict: true }) && proposedParent.length === 66
  const proposedParentId = parentIdValid ? (proposedParent as Hex) : undefined
  const matchingAdminModule =
    moduleDeployment &&
    proposedParentId &&
    moduleDeployment.parentId.toLowerCase() === proposedParentId.toLowerCase()
      ? moduleDeployment
      : null

  const { data: instanceRegistry } = useReadContract({
    address: registry || zeroAddress,
    abi: subnetworkRegistryReadAbi,
    functionName: 'INSTANCE_REGISTRY',
    query: { enabled: !!registry },
  })
  const { data: parentAuthority, isLoading: parentAuthorityLoading } =
    useReadContract({
      address: registry || zeroAddress,
      abi: subnetworkRegistryReadAbi,
      functionName: 'authorityOf',
      args: [proposedParentId ?? parentId],
      query: { enabled: !!registry && !!proposedParentId },
    })

  const prepareProposal = (
    title: string,
    description: string,
    actions: GovernancePrefillAction[]
  ) => {
    if (!registry) return
    const fingerprint = keccak256(
      stringToHex(JSON.stringify({ title, actions }))
    )
    saveGovernancePrefill({
      version: 2,
      networkId: network.id,
      fingerprint,
      title,
      description,
      actions,
      createdAt: Date.now(),
    })
    router.push(
      `/networks/${network.id}/governance?new=1&actionDraft=${fingerprint}`
    )
  }

  const customAction = (
    target: Address,
    data: Hex,
    description: string
  ): GovernancePrefillAction => ({
    actionKey: 'custom',
    values: {
      target,
      valueEth: '0',
      data,
      operation: 0,
      description,
    },
  })

  const claimAction = (parent: Hex) =>
    customAction(
      registry as Address,
      encodeFunctionData({
        abi: subnetworkRegistryWriteAbi,
        functionName: 'claimParent',
        args: [parentId, parent],
      }),
      `Claim ${parent} as this network's parent`
    )

  const deployAdminModule = async () => {
    if (
      !parentModuleDeployer ||
      !instanceRegistry ||
      !childSafe ||
      !proposedParentId
    )
      return
    setDeployingModule(true)
    setAdoptionFailure(null)
    try {
      const [receipt] = await txToast({
        tx: {
          address: parentModuleDeployer,
          abi: parentAuthorityModuleDeployerAbi,
          functionName: 'deploy',
          args: [childSafe, instanceRegistry, parentId, proposedParentId, 0],
        },
        successMessage: 'The inert parent module is ready.',
      })
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== parentModuleDeployer.toLowerCase())
          continue
        try {
          const decoded = decodeEventLog({
            abi: parentAuthorityModuleDeployerAbi,
            data: log.data,
            topics: log.topics,
          })
          if (decoded.eventName === 'ParentAuthorityModuleConfigured') {
            setModuleDeployment({
              address: decoded.args.parentAuthorityModule,
              parentId: proposedParentId,
            })
            return
          }
        } catch {
          // Another deployer event.
        }
      }
      setAdoptionFailure(
        'The deployment succeeded, but its module address was not found in the receipt.'
      )
    } catch (error) {
      setAdoptionFailure(
        error instanceof Error ? error.message : 'Module deployment failed.'
      )
    } finally {
      setDeployingModule(false)
    }
  }

  const claimParent = () => {
    if (!registry || !proposedParentId || !adoptionTier) return
    const actions: GovernancePrefillAction[] = []
    if (adoptionTier === 'admin') {
      if (
        !childSafe ||
        !moduleDeployment ||
        moduleDeployment.parentId.toLowerCase() !==
          proposedParentId.toLowerCase()
      )
        return
      actions.push(
        customAction(
          childSafe,
          encodeFunctionData({
            abi: safeModuleWriteAbi,
            functionName: 'enableModule',
            args: [moduleDeployment.address],
          }),
          `Enable instant parent authority module ${moduleDeployment.address}`
        )
      )
    } else if (adoptionTier === 'guardian') {
      if (!recoveryModule || !parentAuthority) return
      actions.push(
        customAction(
          recoveryModule,
          encodeFunctionData({
            abi: recoveryProposerWriteAbi,
            functionName: 'setProposer',
            args: [parentAuthority],
          }),
          `Set the delayed recovery proposer to the parent’s current authority ${parentAuthority}`
        )
      )
    }
    actions.push(claimAction(proposedParentId))
    const tierLabel =
      adoptionTiers.find(([tier]) => tier === adoptionTier)?.[1] ?? adoptionTier
    prepareProposal(
      `Join a parent network as ${tierLabel}`,
      `Grant the selected ${tierLabel.toLowerCase()} relationship to ${proposedParentId} and ask that network to accept this child separately.`,
      actions
    )
  }

  const acceptChild = (child: SubnetworkRelationship) => {
    if (!registry || !child.child) return
    const data = encodeFunctionData({
      abi: subnetworkRegistryWriteAbi,
      functionName: 'acceptChild',
      args: [child.child.id],
    })
    prepareProposal(
      `Accept ${child.child.name} as a sub-network`,
      `Accept ${child.child.name}'s pending organizational link. This records the relationship but grants no additional power by itself.`,
      [customAction(registry, data, `Accept ${child.child.name} as a child`)]
    )
  }

  const releaseChild = (child: SubnetworkRelationship) => {
    if (!registry || !child.child) return
    const actions: GovernancePrefillAction[] = []
    if (child.power.parentModule) {
      actions.push(
        customAction(
          child.power.parentModule.address,
          encodeFunctionData({
            abi: parentAuthorityModuleWriteAbi,
            functionName: 'renounce',
          }),
          `Renounce parent module power over ${child.child.name}`
        )
      )
    }
    actions.push(
      customAction(
        registry,
        encodeFunctionData({
          abi: subnetworkRegistryWriteAbi,
          functionName: 'release',
          args: [child.child.id],
        }),
        `Release ${child.child.name} from this parent network`
      )
    )
    prepareProposal(
      `Release ${child.child.name}`,
      child.power.parentModule
        ? `Renounce this parent’s module power and release ${child.child.name}'s registry link in one proposal.`
        : `Release ${child.child.name}'s registry link. Any child-owned authority instrument, including its recovery proposer, must be rotated by the child separately.`,
      actions
    )
  }

  return (
    <div className="space-y-10">
      <NetworkHeader
        network={network}
        description="Organizational child networks with their own members, scoring, governance, and funds."
      />

      <section className="space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <SectionHeading>Sub-networks</SectionHeading>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Registry links and parent power are shown separately. A child can
              eject a Safe module without erasing the historical relationship.
            </p>
          </div>
          <ButtonLink
            href={`/create/standard?parent=${parentId}&parentRoute=${encodeURIComponent(network.id)}`}
          >
            <GitFork className="h-4 w-4" /> Create a sub-network
          </ButtonLink>
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading children…</p>
        ) : children.length ? (
          <div className="grid gap-4 md:grid-cols-2">
            {children.map((child) => (
              <SubnetworkCard
                key={child.child?.id ?? child.updatedTxHash}
                link={child}
                onRelease={() => releaseChild(child)}
              />
            ))}
          </div>
        ) : (
          <Card type="outline" size="md">
            <p className="text-sm text-muted-foreground">
              This network has no accepted sub-networks yet.
            </p>
          </Card>
        )}
      </section>

      {pending.length > 0 && (
        <section className="space-y-4">
          <SectionHeading>Waiting for this network</SectionHeading>
          {pending.map((child) => (
            <Card
              key={child.child?.id ?? child.updatedTxHash}
              type="outline"
              size="md"
              className="flex flex-wrap items-center justify-between gap-4"
            >
              <div>
                <div className="text-sm font-medium">
                  {child.child?.name ?? 'Unknown child'}
                </div>
                <p className="text-xs text-muted-foreground">
                  <span className="capitalize">{child.power.tier}</span> tier
                  requested.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!registry || !child.child}
                onClick={() => acceptChild(child)}
              >
                Prepare acceptance proposal
              </Button>
            </Card>
          ))}
        </section>
      )}

      <section className="space-y-4 border-t border-border pt-8">
        <SectionHeading>Join an existing parent</SectionHeading>
        <Card type="outline" size="md" className="space-y-4">
          <p className="max-w-2xl text-sm text-muted-foreground">
            This two-proposal handshake lets this network choose exactly what
            power to grant. This network proposes the power instrument and claim
            together; the parent accepts separately.
          </p>
          <label className="space-y-2 text-sm">
            <span>Parent instance ID</span>
            <Input
              value={proposedParent}
              onChange={(event) => {
                setProposedParent(event.target.value.trim())
                setAdoptionFailure(null)
              }}
              placeholder="0x…"
            />
          </label>
          <div className="grid gap-2 sm:grid-cols-3">
            {adoptionTiers.map(([value, label, description]) => (
              <button
                key={value}
                type="button"
                aria-pressed={adoptionTier === value}
                onClick={() => {
                  setAdoptionTier(value)
                  setAdoptionFailure(null)
                }}
                className={cn(
                  'border p-3 text-left transition-colors',
                  adoptionTier === value
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:border-muted-foreground'
                )}
              >
                <span className="text-sm font-medium">{label}</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {description}
                </span>
              </button>
            ))}
          </div>
          {adoptionTier === 'admin' && (
            <div className="space-y-2 border-l border-border pl-4">
              <p className="text-xs text-muted-foreground">
                Deploy the parent module first. Deployment is permissionless and
                inert; the child proposal is what enables its power.
              </p>
              {matchingAdminModule ? (
                <p className="break-all font-mono text-xs text-success">
                  Module ready: {matchingAdminModule.address}
                </p>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={
                    !parentModuleDeployer ||
                    !instanceRegistry ||
                    !childSafe ||
                    !proposedParentId ||
                    deployingModule
                  }
                  onClick={() => void deployAdminModule()}
                >
                  {deployingModule
                    ? 'Deploying module…'
                    : 'Deploy inert admin module'}
                </Button>
              )}
            </div>
          )}
          {adoptionTier === 'guardian' && (
            <p className="text-xs text-muted-foreground">
              {parentAuthorityLoading
                ? 'Resolving the parent’s current authority…'
                : parentAuthority && recoveryModule
                  ? `The child proposal will set ${parentAuthority} as proposer on the existing delayed recovery module.`
                  : 'The parent authority or this network’s recovery module could not be resolved.'}
            </p>
          )}
          <Button
            type="button"
            variant="outline"
            disabled={
              !registry ||
              !proposedParentId ||
              !adoptionTier ||
              (adoptionTier === 'admin' && !matchingAdminModule) ||
              (adoptionTier === 'guardian' &&
                (!parentAuthority || !recoveryModule))
            }
            onClick={claimParent}
          >
            Prepare adoption proposal
          </Button>
          {adoptionFailure && (
            <p className="text-xs text-error">{adoptionFailure}</p>
          )}
          {!registry && (
            <p className="text-xs text-error">
              This deployment has not published a SubnetworkRegistry address.
            </p>
          )}
        </Card>
      </section>
    </div>
  )
}
