import type { Hex } from 'viem'

export const REVIEW_PERSONAS = ['stranger', 'rater', 'nominee'] as const
export type ReviewPersona = (typeof REVIEW_PERSONAS)[number]

export const REVIEW_PERSONA_STORAGE_KEY = 'tg-review-persona'

export const REVIEW_ACCOUNTS: Record<ReviewPersona, Hex> = {
  stranger: '0x1000000000000000000000000000000000000001',
  rater: '0x2000000000000000000000000000000000000002',
  nominee: '0x3000000000000000000000000000000000000003',
}

export const getReviewPersona = (): ReviewPersona => {
  const stored =
    typeof window === 'undefined'
      ? undefined
      : window.localStorage.getItem(REVIEW_PERSONA_STORAGE_KEY)
  const requested = stored ?? process.env.NEXT_PUBLIC_TG_REVIEW_PERSONA
  return REVIEW_PERSONAS.includes(requested as ReviewPersona)
    ? (requested as ReviewPersona)
    : 'stranger'
}

export const getReviewWalletAccount = (): Hex =>
  REVIEW_ACCOUNTS[getReviewPersona()]
