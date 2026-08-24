//! Build the SP1 guest programs and expose their ELFs to the host via `include_elf!`.
//!
//! **Reproducibly, by default.** Succinct's own documentation says the plain path is not enough:
//! "Running `cargo prove build` may not generate a reproducible ELF which is necessary for
//! verifying that your binary corresponds to given source code." This repository has already
//! measured that in its own words — `research/operations/addresses-and-vkeys.md` records that a
//! toolchain reinstall was observed to shift vkeys with zero source change. Since
//! `SP1JournalVerifier` pins a vkey at construction and the factory pins the verifier, a vkey
//! from a build nobody else can reproduce is a mistake that costs a new verifier AND a new
//! factory to undo.
//!
//! So every guest is compiled inside the pinned SP1 builder image, and the two build modes land
//! in DIFFERENT directories: `target/elf-compilation/docker/…` for the reproducible one and
//! `target/elf-compilation/…` for the plain one. That is what makes the fallback below both
//! necessary and honest — a checkout whose guests predate this change still builds, and says so.

use sp1_build::{build_program_with_args, BuildArgs};
use std::path::{Path, PathBuf};

/// Pinned deliberately and separately from the `sp1-build` version, so a dependency bump cannot
/// silently change every vkey in the system. Kept in step with `scripts/build-guests.sh`.
const SP1_DOCKER_TAG: &str = "v6.3.1";

/// Every isolated guest workspace, and whether its lockfile is frozen.
const GUESTS: &[(&str, bool)] = &[
    ("../program", false),
    ("../trustgraph-program-v2", false),
    ("../weighted-program", false),
    ("../composition-program", false),
    // This one has always been built `--locked`; a guest whose dependency versions can move under
    // it is a guest whose vkey can move under it.
    ("../nostr-program/program", true),
];

const TARGET: &str = "riscv64im-succinct-zkvm-elf/release";

fn main() {
    println!("cargo:rerun-if-env-changed=TRUSTGRAPH_GUEST_BUILD");

    let docker = match std::env::var("TRUSTGRAPH_GUEST_BUILD").as_deref() {
        Ok("local") => {
            warn(
                "building guests WITHOUT --docker: the resulting vkeys are a property of this \
                 machine as much as of the source, and must not be pinned into a verifier",
            );
            false
        }
        _ => true,
    };

    for (path, locked) in GUESTS {
        build_program_with_args(
            path,
            BuildArgs {
                docker,
                tag: SP1_DOCKER_TAG.to_string(),
                locked: *locked,
                ..Default::default()
            },
        );
    }

    if docker {
        fall_back_to_locally_built_guests();
    }
}

/// Point `include_elf!` at a plainly-built guest when no reproducible one exists.
///
/// `sp1_build` emits one `cargo:rustc-env=SP1_ELF_<name>` per program, and cargo takes the LAST
/// value for a key — so re-emitting here overrides it. Without this, every checkout whose guests
/// were built before this file switched to `--docker` fails at `include_elf!` with a missing-file
/// error that reads like a broken repository, and there is no way to build the host at all on a
/// machine with no Docker.
///
/// The warning is the point. This path produces a working prover and an untrustworthy vkey; it
/// must never be the one a deployment value comes from.
fn fall_back_to_locally_built_guests() {
    let mut fell_back = Vec::new();
    for (path, _) in GUESTS {
        let base = Path::new(path).join("target/elf-compilation");
        let local = base.join(TARGET);
        let reproducible = base.join("docker").join(TARGET);
        for elf in elf_files(&local) {
            let Some(name) = elf.file_name().and_then(|n| n.to_str()) else { continue };
            if reproducible.join(name).is_file() {
                continue;
            }
            let absolute = std::fs::canonicalize(&elf).unwrap_or(elf.clone());
            println!("cargo:rustc-env=SP1_ELF_{name}={}", absolute.display());
            fell_back.push(name.to_string());
        }
    }
    if !fell_back.is_empty() {
        fell_back.sort();
        warn(&format!(
            "no reproducible guest ELF for {}; falling back to the locally built one. This \
             binary's vkeys are NOT reproducible — rebuild with `sh scripts/build-guests.sh` \
             before deriving any value that gets pinned on chain",
            fell_back.join(", ")
        ));
    }
}

/// The ELFs directly inside a guest's release directory — not `deps/`, `.fingerprint/`, the `.d`
/// dependency lists, or cargo's lock files.
fn elf_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path.extension().is_none()
                && !path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with('.'))
        })
        .collect()
}

fn warn(message: &str) {
    println!("cargo:warning={message}");
}
