//! Empty-guest baseline: read one u32, commit it. Everything else measures the marginal cost
//! over this (SP1 boot + a single io::read + a single io::commit).
#![no_main]
sp1_zkvm::entrypoint!(main);

pub fn main() {
    let x: u32 = sp1_zkvm::io::read();
    sp1_zkvm::io::commit_slice(&x.to_le_bytes());
}
