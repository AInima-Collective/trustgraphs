import { useRef } from 'react'

/**
 * A non-nullable ref with a current value that cannot be changed. This is used
 * by `useUpdatingRef` to prevent modifying the returned mutable ref object.
 */
export type ImmutableRef<T = unknown> = {
  readonly current: T
}

/**
 * Create ref that is updated on every render. This effectively memoizes the
 * value so it can be used in effects without causing constant re-renders.
 */
export const useUpdatingRef = <T extends unknown>(
  value: T
): ImmutableRef<T> => {
  const ref = useRef(value)
  ref.current = value
  return ref
}
