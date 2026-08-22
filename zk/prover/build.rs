//! Build the SP1 guest program and expose its ELF to the host via `include_elf!`.
fn main() {
    sp1_build::build_program("../program");
    sp1_build::build_program("../trustgraph-program-v2");
    sp1_build::build_program("../weighted-program");
    sp1_build::build_program("../composition-program");
    sp1_build::build_program("../nostr-program/program");
}
