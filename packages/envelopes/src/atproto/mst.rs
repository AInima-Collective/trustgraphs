//! MST decode (serde_ipld_dagcbor) + canonical-invariant full walk and range walk.

use super::carset::Car;
use ipld_core::cid::Cid;
use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
struct RawEntry {
    /// prefix length shared with previous key in this node
    p: usize,
    /// key suffix
    #[serde(with = "serde_bytes")]
    k: Vec<u8>,
    /// value CID
    v: Cid,
    /// right subtree CID (nullable)
    #[serde(default)]
    t: Option<Cid>,
}

#[derive(Deserialize)]
struct RawNode {
    /// leftmost subtree CID (nullable)
    #[serde(default)]
    l: Option<Cid>,
    e: Vec<RawEntry>,
}

/// leading-zero-bits of SHA-256(key) / 2  => MST layer for the key.
pub fn key_layer(key: &[u8]) -> u32 {
    let h = Sha256::digest(key);
    let mut clz = 0u32;
    for &b in h.iter() {
        if b == 0 {
            clz += 8;
        } else {
            clz += b.leading_zeros();
            break;
        }
    }
    clz / 2
}

fn lcp(a: &[u8], b: &[u8]) -> usize {
    a.iter().zip(b.iter()).take_while(|(x, y)| x == y).count()
}

/// Result of a walk: ordered (key, value-CID) pairs.
pub struct WalkOut {
    pub entries: Vec<(Vec<u8>, Cid)>,
    pub nodes_visited: usize,
    pub node_cids: Vec<Cid>,
}

pub struct Walker<'a> {
    car: &'a Car,
    out: Vec<(Vec<u8>, Cid)>,
    prev_key: Option<Vec<u8>>,
    nodes: usize,
    node_cids: Vec<Cid>,
    // range filter, None = full walk
    lo: Option<Vec<u8>>,
    hi: Option<Vec<u8>>,
}

impl<'a> Walker<'a> {
    pub fn full(car: &'a Car) -> Self {
        Walker { car, out: vec![], prev_key: None, nodes: 0, node_cids: vec![], lo: None, hi: None }
    }
    pub fn range(car: &'a Car, lo: Vec<u8>, hi: Vec<u8>) -> Self {
        Walker {
            car,
            out: vec![],
            prev_key: None,
            nodes: 0,
            node_cids: vec![],
            lo: Some(lo),
            hi: Some(hi),
        }
    }

    fn in_range(&self, key: &[u8]) -> bool {
        if let Some(lo) = &self.lo {
            if key < lo.as_slice() {
                return false;
            }
        }
        if let Some(hi) = &self.hi {
            if key >= hi.as_slice() {
                return false;
            }
        }
        true
    }

    fn decode(&self, cid: &Cid) -> Result<RawNode, String> {
        let bytes = self
            .car
            .get(cid)
            .ok_or_else(|| format!("FAIL-CLOSED: MST block {cid} missing from CAR"))?;
        let node: RawNode = serde_ipld_dagcbor::from_slice(bytes)
            .map_err(|e| format!("dag-cbor decode {cid}: {e}"))?;
        Ok(node)
    }

    /// Walk subtree rooted at `cid`; `parent_layer` = Some when we know the parent's
    /// layer (child layer must be strictly less). Returns this node's layer.
    fn walk(&mut self, cid: &Cid, parent_layer: Option<u32>) -> Result<u32, String> {
        let node = self.decode(cid)?;
        self.nodes += 1;
        self.node_cids.push(*cid);

        // reconstruct keys + node-local invariants
        let mut keys: Vec<Vec<u8>> = Vec::with_capacity(node.e.len());
        let mut prev_in_node: Vec<u8> = Vec::new();
        for (i, e) in node.e.iter().enumerate() {
            if i == 0 && e.p != 0 {
                return Err(format!("{cid}: first entry has prefix p={} != 0", e.p));
            }
            if e.p > prev_in_node.len() {
                return Err(format!(
                    "{cid}: prefix p={} exceeds prev key len {}",
                    e.p,
                    prev_in_node.len()
                ));
            }
            let mut key = prev_in_node[..e.p].to_vec();
            key.extend_from_slice(&e.k);
            // canonical prefix-compression: p must be the FULL shared prefix
            if i > 0 {
                let shared = lcp(&prev_in_node, &key);
                if shared != e.p {
                    return Err(format!(
                        "{cid}: non-canonical prefix compression (p={}, actual lcp={})",
                        e.p, shared
                    ));
                }
                if key <= prev_in_node {
                    return Err(format!("{cid}: keys not strictly ascending within node"));
                }
            }
            keys.push(key.clone());
            prev_in_node = key;
        }

        // layer rule: all entry keys share one layer == node layer
        let node_layer = if keys.is_empty() {
            // empty node: layer must come from parent context; treat as parent-1
            parent_layer.map(|p| p.saturating_sub(1)).unwrap_or(0)
        } else {
            let l0 = key_layer(&keys[0]);
            for k in &keys {
                let lk = key_layer(k);
                if lk != l0 {
                    return Err(format!("{cid}: entry keys span multiple layers ({l0} vs {lk})"));
                }
            }
            l0
        };
        if let Some(pl) = parent_layer {
            if node_layer >= pl {
                return Err(format!("{cid}: child layer {node_layer} >= parent layer {pl}"));
            }
        }

        // in-order traversal: l, (e[i].k, e[i].t)*
        self.maybe_descend(&node.l, node_layer, None, keys.first().map(|v| v.as_slice()))?;
        for (i, e) in node.e.iter().enumerate() {
            let key = &keys[i];
            // strictly-ascending across the whole tree
            if let Some(pk) = &self.prev_key {
                if key <= pk {
                    return Err(format!(
                        "global key order violation at key {:02x?}",
                        &key[..key.len().min(24)]
                    ));
                }
            }
            if self.in_range(key) {
                self.out.push((key.clone(), e.v));
            }
            self.prev_key = Some(key.clone());

            let next_key = keys.get(i + 1).map(|v| v.as_slice());
            self.maybe_descend(&e.t, node_layer, Some(key.as_slice()), next_key)?;
        }

        Ok(node_layer)
    }

    /// Descend into a subtree bounded by (left_key, right_key) if it could contain
    /// in-range keys. Fail-closed: a referenced-but-missing block is an error.
    fn maybe_descend(
        &mut self,
        sub: &Option<Cid>,
        parent_layer: u32,
        left_key: Option<&[u8]>,
        right_key: Option<&[u8]>,
    ) -> Result<(), String> {
        let cid = match sub {
            Some(c) => c,
            None => return Ok(()),
        };
        // range pruning: subtree covers open interval (left_key, right_key).
        if let Some(hi) = &self.hi {
            // if the whole subtree lies at/above hi, skip
            if let Some(lk) = left_key {
                if lk >= hi.as_slice() {
                    return Ok(());
                }
            }
        }
        if let Some(lo) = &self.lo {
            // if the whole subtree lies below lo, skip
            if let Some(rk) = right_key {
                if rk <= lo.as_slice() {
                    return Ok(());
                }
            }
        }
        self.walk(cid, Some(parent_layer))?;
        Ok(())
    }

    pub fn run(mut self, root: &Cid) -> Result<WalkOut, String> {
        self.walk(root, None)?;
        Ok(WalkOut { entries: self.out, nodes_visited: self.nodes, node_cids: self.node_cids })
    }
}
