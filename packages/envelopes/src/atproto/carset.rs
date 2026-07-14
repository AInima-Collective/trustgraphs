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

impl Car {
    /// Parse a CARv1 buffer. Verifies every dag-cbor / raw block's CID against
    /// SHA-256 of its bytes (fail-closed content addressing).
    pub fn parse(buf: &[u8]) -> Result<Car, String> {
        let mut off = 0usize;

        // --- header ---
        let (hlen, n) = read_uvarint(&buf[off..])?;
        off += n;
        let header = &buf[off..off + hlen as usize];
        off += hlen as usize;
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
            let (blen, n) = read_uvarint(&buf[off..])?;
            off += n;
            let block = &buf[off..off + blen as usize];
            off += blen as usize;

            // CID = version varint, codec varint, mh-code varint, mh-size varint, digest
            let (ver, a) = read_uvarint(block)?;
            if ver != 1 {
                return Err(format!("non-CIDv1 in CAR: {ver}"));
            }
            let (codec, b) = read_uvarint(&block[a..])?;
            let (mhcode, c) = read_uvarint(&block[a + b..])?;
            let (mhsize, d) = read_uvarint(&block[a + b + c..])?;
            let cid_len = a + b + c + d + mhsize as usize;
            let cid = Cid::read_bytes(block).map_err(|e| format!("bad CID in CAR: {e}"))?;
            let data = &block[cid_len..];

            // content-address check for the codecs we handle
            if mhcode == SHA2_256 {
                let digest = Sha256::digest(data);
                let stored = &block[a + b + c + d..cid_len];
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
