'use client'

import { Input } from '@/components/Input'
import { Textarea } from '@/components/Textarea'

import {
  MAX_NAME_BYTES,
  WizardData,
  byteLength,
  nameProblem,
  urlProblem,
} from '../model'
import { Field, Note, StepHeader } from '../ui'

export const IdentityStep = ({
  data,
  onChange,
  showErrors,
}: {
  data: WizardData
  onChange: (patch: Partial<WizardData>) => void
  showErrors: boolean
}) => {
  const nameError = showErrors ? nameProblem(data.name) : null
  const imageError = showErrors ? urlProblem(data.image) : null
  const applicationError = showErrors ? urlProblem(data.applicationUrl) : null
  const nameLength = byteLength(data.name)

  return (
    <div className="space-y-6">
      <StepHeader
        title="What is this network?"
        lead="This is what people see when they land on your network's page. You can leave everything but the name blank and fill it in later."
      />

      <Field
        label="Name"
        htmlFor="network-name"
        error={nameError}
        hint={
          <>
            Short and recognisable, like the name of your community.{' '}
            <span className="tabular-nums">
              {nameLength}/{MAX_NAME_BYTES}
            </span>
          </>
        }
      >
        <Input
          id="network-name"
          value={data.name}
          maxLength={MAX_NAME_BYTES}
          placeholder="Riverside Mutual Aid"
          onChange={(e) => onChange({ name: e.target.value })}
        />
      </Field>

      <Field
        label="What is this network for?"
        htmlFor="network-description"
        optional
        hint="One or two sentences a newcomer would understand."
      >
        <Textarea
          id="network-description"
          value={data.description}
          rows={3}
          maxLength={2_000}
          placeholder="We are the volunteers who keep the Riverside food bank running. Members vouch for people they have actually worked alongside."
          onChange={(e) => onChange({ description: e.target.value })}
        />
      </Field>

      <Field
        label="What does it mean to vouch for someone here?"
        htmlFor="network-criteria"
        optional
        hint="Members read this before they vouch, so it is the main thing keeping everyone to the same standard. Basic formatting works: **bold**, lists, links."
      >
        <Textarea
          id="network-criteria"
          value={data.criteria}
          rows={6}
          maxLength={8_000}
          placeholder={
            'Vouch for someone if both are true:\n\n- You have worked with them in person at least twice.\n- You would be comfortable handing them the keys.'
          }
          onChange={(e) => onChange({ criteria: e.target.value })}
        />
      </Field>

      <Field
        label="Logo or banner image"
        htmlFor="network-image"
        optional
        error={imageError}
        hint="A link to an image already on the web or on IPFS. We do not host images for you."
      >
        <Input
          id="network-image"
          value={data.image}
          placeholder="https://example.org/logo.png"
          onChange={(e) => onChange({ image: e.target.value })}
        />
      </Field>

      <Field
        label="Where can someone ask to join?"
        htmlFor="network-application"
        optional
        error={applicationError}
        hint="A form, a chat invite, a page on your site: anywhere a newcomer can introduce themselves."
        className="pb-2"
      >
        <Input
          id="network-application"
          value={data.applicationUrl}
          placeholder="https://example.org/apply"
          onChange={(e) => onChange({ applicationUrl: e.target.value })}
        />
      </Field>

      <Note>
        When you continue, this text is saved to IPFS, a public file network,
        and your network points at it. Anyone can read it. Keep private details
        out.
      </Note>
    </div>
  )
}
