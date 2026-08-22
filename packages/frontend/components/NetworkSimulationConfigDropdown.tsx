'use client'

import { ChevronDown } from 'lucide-react'

import { useNetwork } from '@/contexts/NetworkContext'

import { Button, ButtonProps } from './Button'
import { InfoTooltip } from './InfoTooltip'
import { Input } from './Input'
import { Popup } from './Popup'
import { Switch } from './Switch'

export type NetworkSimulationConfigDropdownProps = {
  className?: string
  size?: ButtonProps['size']
}

export const NetworkSimulationConfigDropdown = ({
  className,
  size = 'default',
}: NetworkSimulationConfigDropdownProps) => {
  const { simulationConfig, setSimulationConfig, envelope0Verification } =
    useNetwork()

  return (
    <Popup
      position="left"
      popupClassName="!p-0"
      popupPadding={0}
      trigger={{
        type: 'custom',
        Renderer: ({ onClick, open }) => (
          <Button
            variant={
              open
                ? 'outline'
                : simulationConfig.enabled
                  ? 'brand'
                  : 'secondary'
            }
            onClick={onClick}
            size={size}
            className={className}
          >
            <span>{simulationConfig.enabled ? 'SIMULATING' : 'SIMULATE'}</span>
            <ChevronDown className="w-4 h-4" />
          </Button>
        ),
      }}
    >
      <Button
        variant="ghost"
        className="!justify-between !rounded-none !px-3 !pt-2.5 !pb-2 !gap-4"
        size={null}
        onClick={() =>
          setSimulationConfig((config) => ({
            ...config,
            enabled: !config.enabled,
          }))
        }
      >
        <span>{simulationConfig.enabled ? 'Enabled' : 'Disabled'}</span>
        <Switch
          onClick={(e) => {
            e.stopPropagation()
            setSimulationConfig((config) => ({
              ...config,
              enabled: !config.enabled,
            }))
          }}
          size="md"
          enabled={simulationConfig.enabled}
        />
      </Button>

      {envelope0Verification && (
        <div
          className={`border-y border-border px-3 py-2 text-xs ${
            envelope0Verification.status === 'failed'
              ? 'text-destructive'
              : 'text-muted-foreground'
          }`}
        >
          <div className="font-medium text-foreground">
            Strict-lane verification: {envelope0Verification.status}
          </div>
          <div>{envelope0Verification.message}</div>
        </div>
      )}

      <div className="flex flex-row justify-between items-center gap-4 px-3 pt-2.5 pb-2 text-sm">
        <div className="flex flex-row items-center gap-1">
          <span>Damping Factor</span>
          <InfoTooltip title="The proportion (0 to 1) of each attestation that carries over to the recipient—it's an artifact of the PageRank algorithm that minimizes the impact of cycles (e.g. spam rings) and speeds up convergence. Closer to 1 means less damping, closer to 0 means more damping." />
        </div>
        <Input
          value={simulationConfig.dampingFactor}
          onChange={(e) =>
            setSimulationConfig((config) => ({
              ...config,
              dampingFactor: Number(e.target.value),
            }))
          }
          step={0.01}
          min={0}
          max={1}
          type="number"
          className="text-sm w-32"
        />
      </div>

      <div className="flex flex-row justify-between items-center gap-4 px-3 py-2 text-sm">
        <div className="flex flex-row items-center gap-1">
          <span>Trust Multiplier</span>
          <InfoTooltip title="The factor (≥ 1) by which the weight of attestations from trusted seeds is multiplied. Higher values mean more weight, lower values mean less weight." />
        </div>
        <Input
          value={simulationConfig.trustMultiplier}
          onChange={(e) =>
            setSimulationConfig((config) => ({
              ...config,
              trustMultiplier: Number(e.target.value),
            }))
          }
          step={0.1}
          type="number"
          min={1}
          className="text-sm w-32"
        />
      </div>

      <div className="flex flex-row justify-between items-center gap-4 px-3 py-2 text-sm">
        <div className="flex flex-row items-center gap-1">
          <span>Trust Share</span>
          <InfoTooltip title="The proportion (0 to 1) of initial weight distributed to trusted seeds at the beginning (to be propagated out through their attestations). The remainder is distributed evenly among all untrusted attesters. Setting it to 1 ensures only people receiving attestations directly or indirectly from a source trusted seed can participate in the network—this is full Trust Aware PageRank. Setting it to 0 means every attester is assigned an equal base weight to distribute. Any value less than 1 means that anyone can join the network by making an attestation to someone else, even if they don't receive any attestations themselves." />
        </div>
        <Input
          value={simulationConfig.trustShare}
          onChange={(e) =>
            setSimulationConfig((config) => ({
              ...config,
              trustShare: Number(e.target.value),
            }))
          }
          step={0.01}
          min={0}
          max={1}
          type="number"
          className="text-sm w-32"
        />
      </div>

      <div className="flex flex-row justify-between items-center gap-4 px-3 pt-2.5 pb-2 text-sm">
        <div className="flex flex-row items-center gap-1">
          <span>Trust Decay</span>
          <InfoTooltip title="The factor (0 to 1) applied to an attester's weight (and thus their attestations) for each degree removed they are from a trusted seed. Closer to 1 means slower decay, closer to 0 means faster decay. For example: a trust decay of 0.8 means that an attester 3 degrees away from a trusted seed receives only 51.2% (0.8^3) of the weight that trusted seeds receive." />
        </div>
        <Input
          value={simulationConfig.trustDecay}
          onChange={(e) =>
            setSimulationConfig((config) => ({
              ...config,
              trustDecay: Number(e.target.value),
            }))
          }
          step={0.01}
          type="number"
          min={0}
          max={1}
          className="text-sm w-32"
        />
      </div>

      <div className="flex flex-row justify-between items-center gap-4 px-3 pt-2.5 pb-2 text-sm">
        <div className="flex flex-row items-center gap-1">
          <span>Max Iterations</span>
          <InfoTooltip title="The maximum number of iterations (≥ 1) the PageRank algorithm will run before stopping, if it fails to converge before then. Higher values mean more accurate results but slower computation—lower values mean the opposite. This should be increased for larger networks." />
        </div>
        <Input
          value={simulationConfig.maxIterations}
          onChange={(e) =>
            setSimulationConfig((config) => ({
              ...config,
              maxIterations: Number(e.target.value),
            }))
          }
          step={1}
          type="number"
          min={1}
          className="text-sm w-32"
        />
      </div>
    </Popup>
  )
}
