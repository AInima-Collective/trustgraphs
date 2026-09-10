import { Button } from './Button'

export function DraftNotice({
  pending,
  status,
  onRestore,
  onDiscard,
}: {
  pending: boolean
  status: string
  onRestore: () => void
  onDiscard: () => void
}) {
  return pending ? (
    <div
      className="space-y-3 border border-border bg-surface p-4"
      role="region"
      aria-label="Saved draft"
    >
      <p className="text-sm">You have a saved draft on this network.</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={onRestore}>
          Restore draft
        </Button>
        <Button type="button" variant="ghost" onClick={onDiscard}>
          Discard saved draft
        </Button>
      </div>
    </div>
  ) : (
    <p role="status" className="text-xs text-muted-foreground">
      {status}
    </p>
  )
}
