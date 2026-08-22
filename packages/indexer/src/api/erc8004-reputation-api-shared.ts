import { isAddress } from 'viem'

export type FeedbackCursor = {
  blockNumber: string
  transactionIndex: number
  logIndex: number
  id: string
}

export const encodeFeedbackCursor = (cursor: FeedbackCursor) =>
  Buffer.from(JSON.stringify(cursor)).toString('base64url')

export const parseFeedbackCursor = (
  value: string | undefined
): FeedbackCursor | null => {
  if (!value) return null
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8')
    ) as Partial<FeedbackCursor>
    if (
      typeof parsed.blockNumber !== 'string' ||
      !/^\d+$/.test(parsed.blockNumber) ||
      !Number.isSafeInteger(parsed.transactionIndex) ||
      parsed.transactionIndex! < 0 ||
      !Number.isSafeInteger(parsed.logIndex) ||
      parsed.logIndex! < 0 ||
      typeof parsed.id !== 'string' ||
      parsed.id.length === 0 ||
      parsed.id.length > 512
    ) {
      return null
    }
    return parsed as FeedbackCursor
  } catch {
    return null
  }
}

export type FeedbackQuery = {
  agent: string | null
  reviewer: string | null
  tag: string | null
  unit: string | null
  revoked: 'all' | 'active' | 'revoked'
  fromBlock: bigint | null
  toBlock: bigint | null
  limit: number
  cursor: FeedbackCursor | null
}

export const parseFeedbackQuery = (
  get: (name: string) => string | undefined
): { value: FeedbackQuery | null; error: string | null } => {
  const agent = get('agent')?.trim() || null
  if (agent && !/^agent:eip155:\d+:0x[0-9a-fA-F]{40}:\d+$/.test(agent)) {
    return {
      value: null,
      error: 'agent must be a qualified ERC-8004 agent key',
    }
  }
  const reviewerRaw = get('reviewer')?.trim() || null
  if (reviewerRaw && !isAddress(reviewerRaw, { strict: false })) {
    return { value: null, error: 'reviewer must be an EVM address' }
  }
  const tag = get('tag') ?? null
  const unit = get('unit') ?? null
  if ((tag?.length ?? 0) > 256 || (unit?.length ?? 0) > 256) {
    return {
      value: null,
      error: 'tag and unit filters are limited to 256 characters',
    }
  }
  const revokedRaw = get('revoked') ?? 'all'
  if (!['all', 'active', 'revoked'].includes(revokedRaw)) {
    return { value: null, error: 'revoked must be all, active, or revoked' }
  }
  const decimal = (name: string): bigint | null | undefined => {
    const raw = get(name)
    if (raw === undefined || raw === '') return null
    return /^\d+$/.test(raw) ? BigInt(raw) : undefined
  }
  const fromBlock = decimal('fromBlock')
  const toBlock = decimal('toBlock')
  if (fromBlock === undefined || toBlock === undefined) {
    return {
      value: null,
      error: 'block bounds must be unsigned decimal integers',
    }
  }
  if (fromBlock !== null && toBlock !== null && fromBlock > toBlock) {
    return { value: null, error: 'fromBlock must not exceed toBlock' }
  }
  const limitRaw = Number(get('limit') ?? 50)
  if (!Number.isSafeInteger(limitRaw) || limitRaw < 1 || limitRaw > 100) {
    return { value: null, error: 'limit must be an integer from 1 to 100' }
  }
  const cursorRaw = get('cursor')
  const cursor = parseFeedbackCursor(cursorRaw)
  if (cursorRaw && !cursor) return { value: null, error: 'cursor is invalid' }
  return {
    value: {
      agent: agent?.toLowerCase() ?? null,
      reviewer: reviewerRaw?.toLowerCase() ?? null,
      tag,
      unit,
      revoked: revokedRaw as FeedbackQuery['revoked'],
      fromBlock,
      toBlock,
      limit: limitRaw,
      cursor,
    },
    error: null,
  }
}
