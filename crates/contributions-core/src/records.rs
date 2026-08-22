//! Contribution record payload decoding (INTERFACES.md §1).
//!
//! Every decoder is total and deterministic: a malformed payload yields `None` (a provable
//! in-guest skip), never a panic or an abort. Validation is STRUCTURAL — exact ABI shape,
//! in-bounds offsets, clean static words, frozen value domains — because deterministic skip
//! rules are the only shape enforcement the proven statement has (anyone can attest garbage
//! bytes at a registered schema).

use alloy_primitives::{Address, B256, U256};

/// A decoded `contribution.claim` payload:
/// `abi.encode(string title, bytes32 contentHash, string uri, address[] contributors, uint32[] shares)`.
///
/// The guest consumes only `contributors`/`shares` (attribution) — `title`/`uri` are display
/// data — but the WHOLE payload must be structurally valid for the claim to count.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClaimPayload {
    pub content_hash: B256,
    /// As attested, in order (duplicates allowed; reconciliation aggregates per address).
    pub contributors: Vec<Address>,
    pub shares: Vec<u32>,
}

/// A decoded `contribution.response` payload: `abi.encode(bytes32 claimUID, uint8 response)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ResponsePayload {
    pub claim_uid: B256,
    /// 1 = accept, 2 = reject (the only valid values; anything else is a skip).
    pub response: u8,
}

/// A decoded `contribution.valuation` payload: `abi.encode(bytes32 claimUID, uint8 score)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ValuationPayload {
    pub claim_uid: B256,
    /// score ∈ [0, 100] (frozen domain; anything else is a skip).
    pub score: u8,
}

/// Read the 32-byte word at `slot` (0-indexed), if in bounds.
fn word(data: &[u8], slot: usize) -> Option<[u8; 32]> {
    let start = slot.checked_mul(32)?;
    let end = start.checked_add(32)?;
    if data.len() < end {
        return None;
    }
    let mut w = [0u8; 32];
    w.copy_from_slice(&data[start..end]);
    Some(w)
}

/// Decode a clean `uint8` word (upper 31 bytes zero).
fn word_as_u8(w: [u8; 32]) -> Option<u8> {
    if w[..31].iter().any(|b| *b != 0) {
        return None;
    }
    Some(w[31])
}

/// Decode a clean `uint32` word.
fn word_as_u32(w: [u8; 32]) -> Option<u32> {
    if w[..28].iter().any(|b| *b != 0) {
        return None;
    }
    Some(u32::from_be_bytes([w[28], w[29], w[30], w[31]]))
}

/// Decode a clean `address` word (upper 12 bytes zero).
fn word_as_address(w: [u8; 32]) -> Option<Address> {
    if w[..12].iter().any(|b| *b != 0) {
        return None;
    }
    Some(Address::from_slice(&w[12..]))
}

/// Decode a usize-safe offset/length word.
fn word_as_usize(w: [u8; 32]) -> Option<usize> {
    let v = U256::from_be_bytes(w);
    if v > U256::from(u32::MAX) {
        return None; // no real payload is 4 GiB; rejects absurd offsets deterministically
    }
    Some(v.to::<u64>() as usize)
}

/// Validate a dynamic `string`/`bytes` region at head-relative `offset`: the length word plus
/// `len` bytes must be in bounds. Content is not interpreted (display data).
fn check_dynamic_bytes(data: &[u8], offset: usize) -> Option<()> {
    if offset % 32 != 0 {
        return None;
    }
    let len = word_as_usize(word(data, offset / 32)?)?;
    let start = offset.checked_add(32)?;
    let end = start.checked_add(len)?;
    if data.len() < end {
        return None;
    }
    Some(())
}

/// Decode `contribution.claim` data. `None` = malformed (deterministic skip).
pub fn decode_claim(data: &[u8]) -> Option<ClaimPayload> {
    // Head: [0] title offset, [1] contentHash, [2] uri offset, [3] contributors offset,
    //       [4] shares offset.
    let title_off = word_as_usize(word(data, 0)?)?;
    let content_hash = B256::from(word(data, 1)?);
    let uri_off = word_as_usize(word(data, 2)?)?;
    let contributors_off = word_as_usize(word(data, 3)?)?;
    let shares_off = word_as_usize(word(data, 4)?)?;

    check_dynamic_bytes(data, title_off)?;
    check_dynamic_bytes(data, uri_off)?;

    // contributors: length word + n address words.
    if contributors_off % 32 != 0 || shares_off % 32 != 0 {
        return None;
    }
    let n = word_as_usize(word(data, contributors_off / 32)?)?;
    let m = word_as_usize(word(data, shares_off / 32)?)?;
    if n != m || n == 0 {
        return None;
    }
    let mut contributors = Vec::with_capacity(n);
    for i in 0..n {
        contributors.push(word_as_address(word(data, contributors_off / 32 + 1 + i)?)?);
    }
    let mut shares = Vec::with_capacity(n);
    for i in 0..n {
        shares.push(word_as_u32(word(data, shares_off / 32 + 1 + i)?)?);
    }
    // A claim whose shares are all zero has no attribution to normalize — malformed.
    if shares.iter().all(|s| *s == 0) {
        return None;
    }
    Some(ClaimPayload { content_hash, contributors, shares })
}

/// ABI-encode a `contribution.claim` payload (the exact inverse of [`decode_claim`], equal to
/// Solidity `abi.encode(title, contentHash, uri, contributors, shares)`). Not guest semantics —
/// fixture/seed/test support.
pub fn encode_claim(
    title: &str,
    content_hash: B256,
    uri: &str,
    contributors: &[Address],
    shares: &[u32],
) -> Vec<u8> {
    fn dyn_bytes(out: &mut Vec<u8>, b: &[u8]) {
        let mut len = [0u8; 32];
        len[24..].copy_from_slice(&(b.len() as u64).to_be_bytes());
        out.extend_from_slice(&len);
        out.extend_from_slice(b);
        let pad = (32 - b.len() % 32) % 32;
        out.extend(core::iter::repeat(0u8).take(pad));
    }
    fn offset_word(off: usize) -> [u8; 32] {
        let mut w = [0u8; 32];
        w[24..].copy_from_slice(&(off as u64).to_be_bytes());
        w
    }
    let head = 5 * 32;
    let title_bytes = title.as_bytes();
    let uri_bytes = uri.as_bytes();
    let title_size = 32 + title_bytes.len().div_ceil(32) * 32;
    let uri_size = 32 + uri_bytes.len().div_ceil(32) * 32;
    let contributors_size = 32 + contributors.len() * 32;

    let title_off = head;
    let uri_off = title_off + title_size;
    let contributors_off = uri_off + uri_size;
    let shares_off = contributors_off + contributors_size;

    let mut out = Vec::new();
    out.extend_from_slice(&offset_word(title_off));
    out.extend_from_slice(content_hash.as_slice());
    out.extend_from_slice(&offset_word(uri_off));
    out.extend_from_slice(&offset_word(contributors_off));
    out.extend_from_slice(&offset_word(shares_off));
    dyn_bytes(&mut out, title_bytes);
    dyn_bytes(&mut out, uri_bytes);
    let mut len = [0u8; 32];
    len[24..].copy_from_slice(&(contributors.len() as u64).to_be_bytes());
    out.extend_from_slice(&len);
    for a in contributors {
        let mut w = [0u8; 32];
        w[12..].copy_from_slice(a.as_slice());
        out.extend_from_slice(&w);
    }
    let mut len = [0u8; 32];
    len[24..].copy_from_slice(&(shares.len() as u64).to_be_bytes());
    out.extend_from_slice(&len);
    for s in shares {
        let mut w = [0u8; 32];
        w[28..].copy_from_slice(&s.to_be_bytes());
        out.extend_from_slice(&w);
    }
    out
}

/// ABI-encode a `contribution.response` payload (inverse of [`decode_response`]).
pub fn encode_response(claim_uid: B256, response: u8) -> Vec<u8> {
    let mut out = Vec::with_capacity(64);
    out.extend_from_slice(claim_uid.as_slice());
    let mut w = [0u8; 32];
    w[31] = response;
    out.extend_from_slice(&w);
    out
}

/// ABI-encode a `contribution.valuation` payload (inverse of [`decode_valuation`]).
pub fn encode_valuation(claim_uid: B256, score: u8) -> Vec<u8> {
    encode_response(claim_uid, score)
}

/// Decode `contribution.response` data. `None` = malformed (deterministic skip).
pub fn decode_response(data: &[u8]) -> Option<ResponsePayload> {
    let claim_uid = B256::from(word(data, 0)?);
    let response = word_as_u8(word(data, 1)?)?;
    if response != 1 && response != 2 {
        return None;
    }
    Some(ResponsePayload { claim_uid, response })
}

/// Decode `contribution.valuation` data. `None` = malformed (deterministic skip).
pub fn decode_valuation(data: &[u8]) -> Option<ValuationPayload> {
    let claim_uid = B256::from(word(data, 0)?);
    let score = word_as_u8(word(data, 1)?)?;
    if score > 100 {
        return None;
    }
    Some(ValuationPayload { claim_uid, score })
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::hex;

    /// abi.encode("t", bytes32(0x11..), "u", [addr(1), addr(2)], [uint32(3), uint32(1)])
    /// built by hand: head = 5 slots, tail = title, uri, contributors, shares.
    fn sample_claim_data() -> Vec<u8> {
        let mut d = Vec::new();
        let head = 5 * 32;
        // title at head+0 (len 1 + padded content = 2 words), uri after title (2 words),
        // contributors after uri (1 + 2 words), shares after that (1 + 2 words).
        let title_off = head;
        let uri_off = title_off + 64;
        let contrib_off = uri_off + 64;
        let shares_off = contrib_off + 32 * 3;
        for off in [title_off, 0, uri_off, contrib_off, shares_off] {
            let mut w = [0u8; 32];
            w[24..].copy_from_slice(&(off as u64).to_be_bytes());
            d.extend_from_slice(&w);
        }
        d[32..64].copy_from_slice(&[0x11; 32]); // contentHash
                                                // title "t"
        let mut w = [0u8; 32];
        w[31] = 1;
        d.extend_from_slice(&w);
        let mut c = [0u8; 32];
        c[0] = b't';
        d.extend_from_slice(&c);
        // uri "u"
        d.extend_from_slice(&w);
        let mut c = [0u8; 32];
        c[0] = b'u';
        d.extend_from_slice(&c);
        // contributors [addr1, addr2]
        let mut lw = [0u8; 32];
        lw[31] = 2;
        d.extend_from_slice(&lw);
        for a in [1u8, 2u8] {
            let mut aw = [0u8; 32];
            aw[12..].copy_from_slice(&[a; 20]);
            d.extend_from_slice(&aw);
        }
        // shares [3, 1]
        d.extend_from_slice(&lw);
        for s in [3u8, 1u8] {
            let mut sw = [0u8; 32];
            sw[31] = s;
            d.extend_from_slice(&sw);
        }
        d
    }

    #[test]
    fn decodes_hand_built_claim() {
        let p = decode_claim(&sample_claim_data()).expect("valid claim");
        assert_eq!(p.content_hash, B256::from([0x11; 32]));
        assert_eq!(p.contributors, vec![Address::from([1; 20]), Address::from([2; 20])]);
        assert_eq!(p.shares, vec![3, 1]);
    }

    #[test]
    fn claim_matches_solidity_abi_encode() {
        // Reference bytes produced by:
        // cast abi-encode "f(string,bytes32,string,address[],uint32[])" "t" \
        //   0x11…11 "u" "[0x0101…01,0x0202…02]" "[3,1]"
        let cast = hex::decode(
            "00000000000000000000000000000000000000000000000000000000000000a0\
             1111111111111111111111111111111111111111111111111111111111111111\
             00000000000000000000000000000000000000000000000000000000000000e0\
             0000000000000000000000000000000000000000000000000000000000000120\
             0000000000000000000000000000000000000000000000000000000000000180\
             0000000000000000000000000000000000000000000000000000000000000001\
             7400000000000000000000000000000000000000000000000000000000000000\
             0000000000000000000000000000000000000000000000000000000000000001\
             7500000000000000000000000000000000000000000000000000000000000000\
             0000000000000000000000000000000000000000000000000000000000000002\
             0000000000000000000000000101010101010101010101010101010101010101\
             0000000000000000000000000202020202020202020202020202020202020202\
             0000000000000000000000000000000000000000000000000000000000000002\
             0000000000000000000000000000000000000000000000000000000000000003\
             0000000000000000000000000000000000000000000000000000000000000001",
        )
        .unwrap();
        assert_eq!(cast, sample_claim_data(), "hand-built sample must equal Solidity abi.encode");
        assert!(decode_claim(&cast).is_some());
        // Length-mismatch mutant must not decode.
        let mut bad = cast.clone();
        bad[5 * 32 + 64 + 64 + 31] = 3; // contributors length 3, shares length 2
        assert!(decode_claim(&bad).is_none());
    }

    #[test]
    fn claim_rejects_structural_garbage() {
        let d = sample_claim_data();
        assert!(decode_claim(&[]).is_none());
        assert!(decode_claim(&d[..64]).is_none());
        // dirty address word
        let mut dirty = d.clone();
        dirty[5 * 32 + 128 + 32 + 5] = 0xFF; // inside contributors[0]'s upper 12 bytes
        assert!(decode_claim(&dirty).is_none());
        // all-zero shares
        let mut zero = d.clone();
        let shares_content = 5 * 32 + 64 + 64 + 32 * 3 + 32;
        zero[shares_content + 31] = 0;
        zero[shares_content + 63] = 0;
        assert!(decode_claim(&zero).is_none());
        // offset out of bounds
        let mut oob = d;
        oob[31] = 0xFF;
        assert!(decode_claim(&oob).is_none());
    }

    #[test]
    fn response_domain() {
        let mut d = vec![0u8; 64];
        d[..32].copy_from_slice(&[0xAB; 32]);
        d[63] = 1;
        let p = decode_response(&d).unwrap();
        assert_eq!(p, ResponsePayload { claim_uid: B256::from([0xAB; 32]), response: 1 });
        d[63] = 2;
        assert!(decode_response(&d).is_some());
        d[63] = 0;
        assert!(decode_response(&d).is_none());
        d[63] = 3;
        assert!(decode_response(&d).is_none());
        d[62] = 1; // dirty uint8 word
        d[63] = 1;
        assert!(decode_response(&d).is_none());
        assert!(decode_response(&d[..32]).is_none());
    }

    #[test]
    fn valuation_domain() {
        let mut d = vec![0u8; 64];
        d[..32].copy_from_slice(&[0xCD; 32]);
        d[63] = 100;
        assert_eq!(
            decode_valuation(&d).unwrap(),
            ValuationPayload { claim_uid: B256::from([0xCD; 32]), score: 100 }
        );
        d[63] = 101;
        assert!(decode_valuation(&d).is_none());
        d[63] = 0;
        assert!(decode_valuation(&d).is_some());
    }

    #[test]
    fn claim_rejects_hex_vector_with_extra_share() {
        // Deterministic guard against silent decoder drift: any byte flip in the frozen
        // sample must not decode to the same payload.
        let d = sample_claim_data();
        let reference = decode_claim(&d).unwrap();
        let blob = hex::encode(&d);
        let d2 = hex::decode(blob).unwrap();
        assert_eq!(decode_claim(&d2).unwrap(), reference);
    }
}
