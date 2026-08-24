'use client'

import { Input } from '@/components/Input'
import { Textarea } from '@/components/Textarea'

import type { NetworkMetadata } from './model'
import { urlProblem } from './model'
import { Field, Note } from './ui'

export type NetworkProfile = Omit<NetworkMetadata, 'name'>

export const EMPTY_NETWORK_PROFILE: NetworkProfile = {
  description: '',
  criteria: '',
  image: '',
  applicationUrl: '',
}

export const networkProfileProblem = (profile: NetworkProfile): string | null =>
  urlProblem(profile.image) || urlProblem(profile.applicationUrl)

export const hasNetworkProfile = (profile: NetworkProfile): boolean =>
  Object.values(profile).some((value) => value.trim().length > 0)

export const NetworkProfileFields = ({
  idPrefix,
  value,
  onChange,
}: {
  idPrefix: string
  value: NetworkProfile
  onChange: (patch: Partial<NetworkProfile>) => void
}) => (
  <div className="space-y-5">
    <Field
      label="What is this network for?"
      htmlFor={`${idPrefix}-description`}
      optional
      hint="One or two sentences a newcomer would understand."
    >
      <Textarea
        id={`${idPrefix}-description`}
        value={value.description}
        rows={3}
        maxLength={2_000}
        placeholder="Describe the community and what its trust scores represent."
        onChange={(event) => onChange({ description: event.target.value })}
      />
    </Field>

    <Field
      label="What does it mean to vouch for someone here?"
      htmlFor={`${idPrefix}-criteria`}
      optional
      hint="Members see this standard before they vouch. Basic Markdown is supported."
    >
      <Textarea
        id={`${idPrefix}-criteria`}
        value={value.criteria}
        rows={5}
        maxLength={8_000}
        placeholder="Vouch for someone when…"
        onChange={(event) => onChange({ criteria: event.target.value })}
      />
    </Field>

    <div className="grid gap-5 sm:grid-cols-2">
      <Field
        label="Logo or banner image"
        htmlFor={`${idPrefix}-image`}
        optional
        error={urlProblem(value.image)}
        hint="Use an http(s) or IPFS image URL."
      >
        <Input
          id={`${idPrefix}-image`}
          value={value.image}
          placeholder="https://example.org/logo.png"
          onChange={(event) => onChange({ image: event.target.value })}
        />
      </Field>

      <Field
        label="Where can someone ask to join?"
        htmlFor={`${idPrefix}-application`}
        optional
        error={urlProblem(value.applicationUrl)}
        hint="A form, chat invite, or community page."
      >
        <Input
          id={`${idPrefix}-application`}
          value={value.applicationUrl}
          placeholder="https://example.org/apply"
          onChange={(event) => onChange({ applicationUrl: event.target.value })}
        />
      </Field>
    </div>

    <Note>
      If you add profile details, they are saved to IPFS when you simulate the
      creation transaction. Keep private details out.
    </Note>
  </div>
)
