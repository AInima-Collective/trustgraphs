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
//!
//! One thing the docker path needs and the plain path does not: **the mount has to be the
//! repository, not the guest.** `sp1_build` mounts a program's own cargo workspace, and warns that
//! "if the program dir has local dependencies outside of the workspace, building with Docker will
//! fail". Every guest here is its own detached workspace whose path dependencies reach up into
//! `crates/`, so mounting `zk/program` alone resolves `../../crates/contributions-core` to
//! `/crates/contributions-core`, which does not exist in the container. `workspace_directory` is
//! what widens the mount, and leaving it out is what failed the first tagged release.

use sp1_build::{build_program_with_args, BuildArgs};
use std::path::{Path, PathBuf};

/// Pinned deliberately and separately from the `sp1-build` version, so a dependency bump cannot
/// silently change every vkey in the system. Kept in step with `scripts/build-guests.sh`.
const SP1_DOCKER_TAG: &str = "v6.3.1";

/// The repository root, derived from this crate's own manifest directory rather than from whatever
/// working directory a build happened to start in.
fn repo_root() -> PathBuf {
    PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"))
        .join("../..")
}

/// Where a guest's ELFs land, asked of cargo rather than guessed.
///
/// The guess would be `<guest>/target`, and it is wrong for `zk/nostr-program/program`: a target
/// directory belongs to the WORKSPACE, and that guest is a member of the workspace rooted one
/// level up at `zk/nostr-program`. Guessing sent the fallback below to a stale copy and had it
/// override cargo's correct answer — a silent way to embed the wrong guest.
fn guest_target_dir(guest: &str) -> Option<PathBuf> {
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_string());
    let output = std::process::Command::new(cargo)
        .args(["locate-project", "--workspace", "--message-format", "plain", "--manifest-path"])
        .arg(Path::new(guest).join("Cargo.toml"))
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let manifest = PathBuf::from(String::from_utf8(output.stdout).ok()?.trim());
    Some(manifest.parent()?.join("target"))
}

/// Every isolated guest workspace, and whether its lockfile is frozen.
const GUESTS: &[(&str, bool)] = &[
    ("../program", false),
    ("../trust-graph-program", false),
    ("../weighted-program", false),
    ("../composition-program", false),
    ("../composition-program-v2", false),
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

    // What to bind-mount into the builder container. It must be the REPOSITORY: every guest
    // depends on crates outside its own workspace, and `sp1_build` would otherwise mount the guest
    // alone, leaving its `../../crates/…` paths pointing outside the mount.
    let workspace = repo_root().display().to_string();
    for (path, locked) in GUESTS {
        build_program_with_args(
            path,
            BuildArgs {
                docker,
                tag: SP1_DOCKER_TAG.to_string(),
                locked: *locked,
                workspace_directory: Some(workspace.clone()),
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
        let Some(base) = guest_target_dir(path).map(|dir| dir.join("elf-compilation")) else {
            continue;
        };
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
