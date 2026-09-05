/** An asynchronous review may publish or sign only while its original context is current. */
export const createReviewSession = () => {
  let revision = 0
  let context = ''
  const invalidate = () => {
    revision += 1
  }
  return {
    invalidate,
    setContext: (next: string) => {
      if (context !== next) {
        context = next
        invalidate()
      }
    },
    capture: () => {
      const captured = revision
      return {
        active: () => captured === revision,
        assertActive: () => {
          if (captured !== revision)
            throw new Error(
              'The wallet, network, or review changed. Prepare this action again.'
            )
        },
      }
    },
  }
}

export type ReviewOperation = ReturnType<
  ReturnType<typeof createReviewSession>['capture']
>
