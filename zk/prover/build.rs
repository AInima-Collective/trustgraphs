//! Build the SP1 guest program and expose its ELF to the host via `include_elf!`.
fn main() {
    sp1_build::build_program("../program");
    sp1_build::build_program("../weighted-program");
}
