import assert from 'node:assert/strict'

import {
  countRelayAttestations,
  easDelegatedAttestMessage,
  joinEasRelaySignature,
  splitEasRelaySignature,
} from './eas-delegation'

const signature =
  '0x111111111111111111111111111111111111111111111111111111111111111122222222222222222222222222222222222222222222222222222222222222221b' as const
assert.equal(
  joinEasRelaySignature(splitEasRelaySignature(signature)),
  signature
)

const message = easDelegatedAttestMessage({
  attester: '0x1111111111111111111111111111111111111111',
  schema: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  data: {
    recipient: '0x2222222222222222222222222222222222222222',
    expirationTime: '0',
    revocable: true,
    refUID:
      '0x0000000000000000000000000000000000000000000000000000000000000000',
    data: '0x1234',
    value: '0',
  },
  nonce: 7n,
  deadline: 99n,
})
assert.equal(message.nonce, 7n)
assert.equal(message.deadline, 99n)
assert.equal(message.value, 0n)

assert.equal(
  countRelayAttestations([
    {
      schema:
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      data: [
        {
          recipient: '0x2222222222222222222222222222222222222222',
          expirationTime: '0',
          revocable: true,
          refUID:
            '0x0000000000000000000000000000000000000000000000000000000000000000',
          data: '0x',
          value: '0',
        },
      ],
      signatures: [],
      nonces: [],
      attester: '0x1111111111111111111111111111111111111111',
      deadline: '99',
    },
  ]),
  1
)
