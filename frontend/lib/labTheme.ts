'use client'

import { useSyncExternalStore } from 'react'

/**
 * The two axes /lab can steer.
 *
 * [data-type] is a real DOM attribute — tokens.css keys the display serif off
 * it — so switching it repaints the whole app. The mark selection is React
 * state only, because a logo is a component, not a cascade.
 *
 * Both persist to localStorage so a choice survives a reload while it is being
 * lived with. Once a direction is settled, delete the loser geometry from
 * BrandMark, prune the unused families from layout.tsx, and this file collapses
 * to a constant.
 */

export const MARK_IDS = [
  // Graph primitives — the literal substance: nodes and directed edges.
  'edge',
  'triad',
  'fan',
  'fold',
  'mutual',
  'cross',
  // Sigil / seal — the occult-diagram register.
  'seal',
  'pentad',
  'overlap',
  'chord',
  'gate',
  // Rank / mass — PageRank made visible.
  'concentric',
  'orbit',
  'rank',
  'well',
  'quorum',
] as const

export type MarkId = (typeof MARK_IDS)[number]

export const TYPE_IDS = [
  'instrument',
  'cormorant',
  'garamond',
  'spectral',
  'newsreader',
  'mono',
] as const

export type TypeId = (typeof TYPE_IDS)[number]

// `chord` is Jake's pick (2026-07-28): a ring with an inscribed scalene
// triangle and a node at each vertex — three parties corroborating each other
// inside one boundary. Every generated brand asset is drawn from it, so if this
// changes, re-run `pnpm run brand:assets`.
export const DEFAULT_MARK: MarkId = 'chord'
export const DEFAULT_TYPE: TypeId = 'instrument'

const MARK_KEY = 'tg-mark'
const TYPE_KEY = 'tg-type'

const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function read<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T
): T {
  if (typeof window === 'undefined') return fallback
  try {
    const stored = window.localStorage.getItem(key)
    return stored && (allowed as readonly string[]).includes(stored)
      ? (stored as T)
      : fallback
  } catch {
    // Private-mode Safari and friends. A logo experiment is not worth throwing over.
    return fallback
  }
}

// useSyncExternalStore compares snapshots by identity, so these must be cached
// rather than recomputed per call — otherwise every read looks like a change
// and React loops.
let markSnapshot: MarkId | null = null
let typeSnapshot: TypeId | null = null

function getMarkSnapshot(): MarkId {
  if (markSnapshot === null)
    markSnapshot = read(MARK_KEY, MARK_IDS, DEFAULT_MARK)
  return markSnapshot
}

function getTypeSnapshot(): TypeId {
  if (typeSnapshot === null)
    typeSnapshot = read(TYPE_KEY, TYPE_IDS, DEFAULT_TYPE)
  return typeSnapshot
}

// The server has no localStorage, so it always renders the default. The boot
// script in layout.tsx applies the stored [data-type] before first paint, so
// the type axis never flashes; the mark can flip once on hydration, which is
// acceptable for a lab-only affordance.
const getMarkServerSnapshot = (): MarkId => DEFAULT_MARK
const getTypeServerSnapshot = (): TypeId => DEFAULT_TYPE

export function setMarkId(id: MarkId) {
  markSnapshot = id
  try {
    window.localStorage.setItem(MARK_KEY, id)
  } catch {
    /* see read() */
  }
  emit()
}

export function setTypeId(id: TypeId) {
  typeSnapshot = id
  try {
    window.localStorage.setItem(TYPE_KEY, id)
  } catch {
    /* see read() */
  }
  document.documentElement.setAttribute('data-type', id)
  emit()
}

export function useMarkId(): MarkId {
  return useSyncExternalStore(subscribe, getMarkSnapshot, getMarkServerSnapshot)
}

export function useTypeId(): TypeId {
  return useSyncExternalStore(subscribe, getTypeSnapshot, getTypeServerSnapshot)
}
