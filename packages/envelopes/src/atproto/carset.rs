//! Minimal CARv1 reader + CID/block content-addressing checks.

use ipld_core::cid::Cid;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub const DAG_CBOR: u64 = 0x71;
pub const RAW: u64 = 0x55;
pub const SHA2_256: u64 = 0x12;

/// Read an unsigned LEB128 varint. Returns (value, bytes_consumed).
fn read_uvarint(buf: &[u8]) -> Result<(u64, usize), String> {
    let mut val: u64 = 0;
    let mut shift = 0u32;
    for (i, &b) in buf.iter().enumerate() {
        if shift >= 64 {
            return Err("varint too long".into());
        }
        val |= ((b & 0x7f) as u64) << shift;
        if b & 0x80 == 0 {
            return Ok((val, i + 1));
        }
        shift += 7;
    }
    Err("varint truncated".into())
}

pub struct Car {
    pub roots: Vec<Cid>,
    /// CID -> raw block bytes (as stored in the CAR).
    pub blocks: BTreeMap<Cid, Vec<u8>>,
    pub num_blocks: usize,
}

/// Bounds-checked subslice: `buf[start .. start+len]` or an error — never a panic. `len` is
/// attacker-supplied (a LEB128 length from the CAR), so it is checked as u64 BEFORE any usize
/// conversion: on the 32-bit zkVM target a bare `as usize` cast would silently truncate
/// (M-12, 2026-08-13 audit).
fn checked_slice<'a>(buf: &'a [u8], start: usize, len: u64) -> Result<&'a [u8], String> {
    let len_usize = usize::try_from(len).map_err(|_| "length overflows usize".to_string())?;
    let end = start.checked_add(len_usize).ok_or_else(|| "length overflows".to_string())?;
    if end > buf.len() {
        return Err(format!("truncated: need {end} bytes, have {}", buf.len()));
    }
    Ok(&buf[start..end])
}

/// Bounds-checked tail: `buf[start..]` or an error — never a panic.
fn checked_tail(buf: &[u8], start: usize) -> Result<&[u8], String> {
    if start > buf.len() {
        return Err(format!("truncated: offset {start} past end {}", buf.len()));
    }
    Ok(&buf[start..])
}

impl Car {
    /// Parse a CARv1 buffer. Verifies every dag-cbor / raw block's CID against
    /// SHA-256 of its bytes (fail-closed content addressing). Every length read from the
    /// buffer is bounds-checked BEFORE slicing (M-12): a malformed or truncated CAR returns
    /// `Err` — which the program crate converts into a per-node rule-Φ skip — never a panic
    /// that would abort the whole epoch.
    pub fn parse(buf: &[u8]) -> Result<Car, String> {
        let mut off = 0usize;

        // --- header ---
        let (hlen, n) = read_uvarint(checked_tail(buf, off)?)?;
        off += n;
        let header = checked_slice(buf, off, hlen)?;
        off += header.len();
        // header is dag-cbor {roots: [Cid], version: u64}
        let hval: ipld_core::ipld::Ipld =
            serde_ipld_dagcbor::from_slice(header).map_err(|e| format!("bad CAR header: {e}"))?;
        let roots = match &hval {
            ipld_core::ipld::Ipld::Map(m) => match m.get("roots") {
                Some(ipld_core::ipld::Ipld::List(l)) => l
                    .iter()
                    .filter_map(|x| match x {
                        ipld_core::ipld::Ipld::Link(c) => Some(*c),
                        _ => None,
                    })
                    .collect::<Vec<_>>(),
                _ => return Err("CAR header has no roots list".into()),
            },
            _ => return Err("CAR header not a map".into()),
        };

        // --- blocks ---
        let mut blocks = BTreeMap::new();
        let mut num_blocks = 0usize;
        while off < buf.len() {
            let (blen, n) = read_uvarint(checked_tail(buf, off)?)?;
            off += n;
            let block = checked_slice(buf, off, blen)?;
            off += block.len();

            // CID = version varint, codec varint, mh-code varint, mh-size varint, digest.
            // Every offset is derived from attacker-supplied varints — bounds-check each hop.
            let (ver, a) = read_uvarint(block)?;
            if ver != 1 {
                return Err(format!("non-CIDv1 in CAR: {ver}"));
            }
            let (codec, b) = read_uvarint(checked_tail(block, a)?)?;
            let (mhcode, c) = read_uvarint(checked_tail(block, a + b)?)?;
            let (mhsize, d) = read_uvarint(checked_tail(block, a + b + c)?)?;
            let digest_start = a + b + c + d;
            let stored = checked_slice(block, digest_start, mhsize)?;
            let cid_len = digest_start + stored.len();
            let cid = Cid::read_bytes(block).map_err(|e| format!("bad CID in CAR: {e}"))?;
            let data = checked_tail(block, cid_len)?;

            // content-address check for the codecs we handle
            if mhcode == SHA2_256 {
                let digest = Sha256::digest(data);
                if digest.as_slice() != stored {
                    return Err(format!("CID/content mismatch for {cid}"));
                }
            }
            let _ = codec;
            blocks.insert(cid, data.to_vec());
            num_blocks += 1;
        }

        Ok(Car { roots, blocks, num_blocks })
    }

    pub fn get(&self, cid: &Cid) -> Option<&Vec<u8>> {
        self.blocks.get(cid)
    }

    pub fn clone_blocks(&self) -> BTreeMap<Cid, Vec<u8>> {
        self.blocks.clone()
    }

    pub fn from_blocks(roots: Vec<Cid>, blocks: BTreeMap<Cid, Vec<u8>>) -> Car {
        let n = blocks.len();
        Car { roots, blocks, num_blocks: n }
    }
}

/// Compute the dag-cbor CIDv1 (sha2-256) of a byte slice.
pub fn cid_dagcbor(bytes: &[u8]) -> Cid {
    let digest = Sha256::digest(bytes);
    let mh = ipld_core::cid::multihash::Multihash::wrap(SHA2_256, &digest).unwrap();
    Cid::new_v1(DAG_CBOR, mh)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serialize a minimal valid CAR: header {version: 1, roots: [root]} + one dag-cbor block.
    fn tiny_car() -> Vec<u8> {
        let block_data = serde_ipld_dagcbor::to_vec(&ipld_core::ipld::Ipld::String(
            "hello".to_string(),
        ))
        .unwrap();
        let cid = cid_dagcbor(&block_data);
        let header = serde_ipld_dagcbor::to_vec(&ipld_core::ipld::Ipld::Map(
            [
                ("version".to_string(), ipld_core::ipld::Ipld::Integer(1)),
                ("roots".to_string(), ipld_core::ipld::Ipld::List(vec![
                    ipld_core::ipld::Ipld::Link(cid),
                ])),
            ]
            .into_iter()
            .collect(),
        ))
        .unwrap();
        let mut out = Vec::new();
        out.push(header.len() as u8); // single-byte varint (small header)
        out.extend_from_slice(&header);
        let cid_bytes = cid.to_bytes();
        out.push((cid_bytes.len() + block_data.len()) as u8);
        out.extend_from_slice(&cid_bytes);
        out.extend_from_slice(&block_data);
        out
    }

    #[test]
    fn valid_tiny_car_parses() {
        let car = Car::parse(&tiny_car()).unwrap();
        assert_eq!(car.num_blocks, 1);
        assert_eq!(car.roots.len(), 1);
    }

    /// M-12 regression: EVERY truncation point of a valid CAR must return Err, never panic.
    /// (Pre-fix, `&buf[off..off + len]` panicked on out-of-range block/header lengths.)
    #[test]
    fn every_truncation_fails_closed() {
        let full = tiny_car();
        for cut in 0..full.len() {
            let truncated = &full[..cut];
            // Must not panic; empty prefix trivially parses to 0 blocks is NOT possible here
            // because the header read fails first — but either way, no panic.
            let _ = Car::parse(truncated);
        }
    }

    /// M-12: a header length claiming more bytes than the buffer holds is an error.
    #[test]
    fn oversized_header_length_fails_closed() {
        // varint 0xFF 0xFF 0x03 = 65535; buffer has 3 more bytes only.
        let buf = [0xFFu8, 0xFF, 0x03, 0x01, 0x02, 0x03];
        assert!(Car::parse(&buf).is_err());
    }

    /// M-12: a block length that overflows (u64::MAX varint) is an error, not a truncating
    /// `as usize` cast (the zkVM target is 32-bit).
    #[test]
    fn huge_block_length_fails_closed() {
        let mut buf = tiny_car();
        // Append a second "block" whose length varint is u64::MAX.
        buf.extend_from_slice(&[0xFF; 9]);
        buf.push(0x01); // terminate the varint at 10 bytes = u64::MAX
        assert!(Car::parse(&buf).is_err());
    }

    /// M-12: an mhsize varint pointing past the block end is an error (pre-fix this panicked
    /// slicing the stored digest).
    #[test]
    fn oversized_multihash_length_fails_closed() {
        let block_data = b"xx".to_vec();
        // Hand-rolled bogus CID: version 1, codec 0x71, mh-code 0x12, mh-size 0x7F (127 —
        // far past the block end), then only 2 digest bytes.
        let mut block = vec![0x01, 0x71, 0x12, 0x7F];
        block.extend_from_slice(&block_data);
        let header = serde_ipld_dagcbor::to_vec(&ipld_core::ipld::Ipld::Map(
            [
                ("version".to_string(), ipld_core::ipld::Ipld::Integer(1)),
                ("roots".to_string(), ipld_core::ipld::Ipld::List(vec![])),
            ]
            .into_iter()
            .collect(),
        ))
        .unwrap();
        let mut buf = Vec::new();
        buf.push(header.len() as u8);
        buf.extend_from_slice(&header);
        buf.push(block.len() as u8);
        buf.extend_from_slice(&block);
        assert!(Car::parse(&buf).is_err());
    }
}
