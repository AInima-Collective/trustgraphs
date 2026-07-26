import { ButtonLink } from '@/components/Button'

export default function NetworkNotFoundPage() {
  return (
    <div className="flex flex-col justify-center items-center pt-12 gap-4">
      <h1>Network not found</h1>
      <p className="text-sm text-muted-foreground">
        Please check the URL or view all networks below.
      </p>
      <ButtonLink href="/network" className="mt-4">
        View all networks
      </ButtonLink>
    </div>
  )
}
