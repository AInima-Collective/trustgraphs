//! Build both guest crates and expose every bin's ELF to the host via `include_elf!`.
//! `build_program` emits `SP1_ELF_<binname>` for each [[bin]]; bin names are globally unique
//! across the two crates so there is no collision.
fn main() {
    sp1_build::build_program("../guest");
    sp1_build::build_program("../guest-nopatch");
}
