//! Hand-rolled minimal DAG-CBOR decoder specialized to the MST-node schema.
//! Only the shapes that appear in an MST node are supported:
//!   map, text-string (keys), byte-string (k), unsigned int (p),
//!   null, and CID (tag 42 -> byte-string with 0x00 multibase prefix).
//! Purpose: parser-choice timing signal vs serde_ipld_dagcbor.

use ipld_core::cid::Cid;

pub struct HrEntry {
    pub p: usize,
    pub k: Vec<u8>,
    pub v: Cid,
    pub t: Option<Cid>,
}
pub struct HrNode {
    pub l: Option<Cid>,
    pub e: Vec<HrEntry>,
}

struct Reader<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> Reader<'a> {
    fn u8(&mut self) -> Result<u8, String> {
        let v = *self.b.get(self.i).ok_or("eof")?;
        self.i += 1;
        Ok(v)
    }
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        if self.i + n > self.b.len() {
            return Err("eof-take".into());
        }
        let s = &self.b[self.i..self.i + n];
        self.i += n;
        Ok(s)
    }
    /// read CBOR head -> (major type, argument)
    fn head(&mut self) -> Result<(u8, u64), String> {
        let ib = self.u8()?;
        let mt = ib >> 5;
        let ai = ib & 0x1f;
        let arg = match ai {
            0..=23 => ai as u64,
            24 => self.u8()? as u64,
            25 => u16::from_be_bytes(self.take(2)?.try_into().unwrap()) as u64,
            26 => u32::from_be_bytes(self.take(4)?.try_into().unwrap()) as u64,
            27 => u64::from_be_bytes(self.take(8)?.try_into().unwrap()),
            _ => return Err(format!("bad addl-info {ai}")),
        };
        Ok((mt, arg))
    }
    fn cid(&mut self) -> Result<Cid, String> {
        // expect tag 42
        let (mt, tag) = self.head()?;
        if mt != 6 || tag != 42 {
            return Err(format!("expected CID tag 42, got mt={mt} tag={tag}"));
        }
        let (mt2, len) = self.head()?;
        if mt2 != 2 {
            return Err("CID not a byte string".into());
        }
        let raw = self.take(len as usize)?;
        if raw.first() != Some(&0x00) {
            return Err("CID bytes missing 0x00 multibase prefix".into());
        }
        Cid::read_bytes(&raw[1..]).map_err(|e| format!("cid parse: {e}"))
    }
    /// read a nullable CID (null or tag42)
    fn opt_cid(&mut self) -> Result<Option<Cid>, String> {
        let save = self.i;
        let (mt, arg) = self.head()?;
        if mt == 7 && arg == 22 {
            return Ok(None); // null
        }
        self.i = save;
        Ok(Some(self.cid()?))
    }
    fn text(&mut self, n: usize) -> Result<&'a str, String> {
        std::str::from_utf8(self.take(n)?).map_err(|_| "bad utf8".into())
    }
}

pub fn decode_node(bytes: &[u8]) -> Result<HrNode, String> {
    let mut r = Reader { b: bytes, i: 0 };
    let (mt, nkeys) = r.head()?;
    if mt != 5 {
        return Err("node not a map".into());
    }
    let mut l = None;
    let mut e: Vec<HrEntry> = Vec::new();
    for _ in 0..nkeys {
        let (kmt, klen) = r.head()?;
        if kmt != 3 {
            return Err("map key not text".into());
        }
        let key = r.text(klen as usize)?;
        match key {
            "l" => {
                l = r.opt_cid()?;
            }
            "e" => {
                let (amt, alen) = r.head()?;
                if amt != 4 {
                    return Err("e not array".into());
                }
                for _ in 0..alen {
                    // each entry is a 4-key map {e,k? -> order p,k,t,v canonical}
                    let (emt, ekeys) = r.head()?;
                    if emt != 5 {
                        return Err("entry not map".into());
                    }
                    let mut p = 0usize;
                    let mut k = Vec::new();
                    let mut v: Option<Cid> = None;
                    let mut t: Option<Cid> = None;
                    for _ in 0..ekeys {
                        let (fmt, flen) = r.head()?;
                        if fmt != 3 {
                            return Err("entry field key not text".into());
                        }
                        let f = r.text(flen as usize)?;
                        match f {
                            "p" => {
                                let (imt, arg) = r.head()?;
                                if imt != 0 {
                                    return Err("p not uint".into());
                                }
                                p = arg as usize;
                            }
                            "k" => {
                                let (bmt, blen) = r.head()?;
                                if bmt != 2 {
                                    return Err("k not bytes".into());
                                }
                                k = r.take(blen as usize)?.to_vec();
                            }
                            "v" => {
                                v = Some(r.cid()?);
                            }
                            "t" => {
                                t = r.opt_cid()?;
                            }
                            other => return Err(format!("unknown entry field {other}")),
                        }
                    }
                    e.push(HrEntry {
                        p,
                        k,
                        v: v.ok_or("entry missing v")?,
                        t,
                    });
                }
            }
            other => return Err(format!("unknown node field {other}")),
        }
    }
    Ok(HrNode { l, e })
}
