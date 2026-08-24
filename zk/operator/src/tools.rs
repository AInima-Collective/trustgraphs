//! Where the operator's helper executables come from.
//!
//! Input reconstruction runs in a child process on purpose — `zk/operator` is a detached
//! workspace so sp1-sdk's dependency graph never unifies with the root workspace's alloy graph,
//! and `handlers` explains why calling those reconstructions as a library would be the riskier
//! choice. What is NOT on purpose is that the child used to be `cargo`, which drags a Rust
//! toolchain, the entire source tree, and a warm `target/` into production for a daemon whose
//! own binary is self-contained.
//!
//! So the seam stays and only the executable changes (GOAL D1). A tool is looked up in three
//! places, in order:
//!
//! 1. `[ops] tool_dir`, if configured. Configured and missing is an ERROR, never a silent
//!    fallback: an image that has no `cargo` would otherwise fail several seconds later with
//!    "No such file or directory" and no hint about which knob was wrong.
//! 2. Next to the running executable. This is what makes the published image need no
//!    configuration at all — `/usr/local/bin` holds `operator` and its tools together.
//! 3. `cargo run`, with exactly today's arguments, from the repo root. This is the developer
//!    loop (GOAL D2): `task demo` and `tests/e2e/` must keep working from a source checkout
//!    with nothing pre-built.

use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};
use std::process::Command;

/// A helper executable the operator shells out to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tool {
    /// Reconstructs a trust-graph / signer / weighted `input.json` from chain state.
    InputExporter,
    /// The strict Envelope0 live preflight, a second binary of the same crate.
    Envelope0Preflight,
    /// `trustgraph-prover --features fetch`, for `contributions fetch`.
    ProverFetch,
    /// `trustgraph-prover --features witness-nostr`, for `nostr-witness assemble`.
    ProverNostr,
}

impl Tool {
    /// Prebuilt file names to look for, most specific first.
    ///
    /// The two prover lanes differ only by cargo feature, so a single binary built with both
    /// features serves both; the specific names exist for a deployment that would rather build
    /// two lean binaries than one fat one.
    pub fn binaries(self) -> &'static [&'static str] {
        match self {
            Self::InputExporter => &["input-exporter"],
            Self::Envelope0Preflight => &["envelope0-preflight"],
            Self::ProverFetch => &["trustgraph-prover-fetch", "trustgraph-prover"],
            Self::ProverNostr => &["trustgraph-prover-nostr", "trustgraph-prover"],
        }
    }

    /// The `cargo run` invocation this tool has always had, up to and including the `--`.
    fn cargo_args(self) -> &'static [&'static str] {
        match self {
            Self::InputExporter => &["run", "-q", "-p", "input-exporter", "--"],
            Self::Envelope0Preflight => {
                &["run", "-q", "-p", "input-exporter", "--bin", "envelope0-preflight", "--"]
            }
            Self::ProverFetch => &[
                "run",
                "-q",
                "--release",
                "--features",
                "fetch",
                "--manifest-path",
                "zk/prover/Cargo.toml",
                "--",
            ],
            Self::ProverNostr => &[
                "run",
                "-q",
                "--release",
                "--features",
                "witness-nostr",
                "--manifest-path",
                "zk/prover/Cargo.toml",
                "--",
            ],
        }
    }

    /// What to call this in an error a human has to act on.
    pub fn label(self) -> &'static str {
        self.binaries()[0]
    }
}

/// A resolved invocation: the program to run and the arguments that precede the tool's own.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolCommand {
    program: PathBuf,
    leading: Vec<String>,
    cwd: Option<PathBuf>,
    /// False when this resolved to `cargo run`, which is the only mode that needs a compiler.
    prebuilt: bool,
}

impl ToolCommand {
    pub fn is_prebuilt(&self) -> bool {
        self.prebuilt
    }

    /// How the invocation reads in a log or an error, without the tool's own arguments.
    pub fn describe(&self) -> String {
        let mut parts = vec![self.program.display().to_string()];
        parts.extend(self.leading.iter().cloned());
        parts.join(" ")
    }

    /// Build the child process, with the tool's arguments appended to whatever the resolution
    /// prefixed.
    pub fn command<I, S>(&self, args: I) -> Command
    where
        I: IntoIterator<Item = S>,
        S: AsRef<std::ffi::OsStr>,
    {
        let mut cmd = Command::new(&self.program);
        cmd.args(&self.leading);
        cmd.args(args);
        if let Some(dir) = &self.cwd {
            cmd.current_dir(dir);
        }
        // The spawned prover must use the same guest ELFs this binary's vkey checks were made
        // against. Without this a bare daemon run (no wrapping task exporting it) lets build.rs
        // rebuild the guests mid-tick, and the proof comes back under a vkey no verifier pinned.
        // A prebuilt tool cannot rebuild anything, but the variable stays set for both modes so
        // the two paths differ in exactly one thing: which executable runs.
        cmd.env("SP1_SKIP_PROGRAM_BUILD", "true");
        cmd
    }
}

/// Every tool, and how it resolved right now — the answer to "does this box need a compiler?"
/// without waiting for a tick to find out.
///
/// A tool that does not resolve is reported, not fatal. The two lanes Sepolia runs need only
/// `input-exporter`; refusing to start because a deployment carries no `trustgraph-prover` would
/// ground the daemon over a program it was never asked to prove.
pub fn report(tool_dir: Option<&str>) -> Vec<(&'static str, String)> {
    [Tool::InputExporter, Tool::Envelope0Preflight, Tool::ProverFetch, Tool::ProverNostr]
        .into_iter()
        .map(|tool| {
            let outcome = match resolve(tool, tool_dir) {
                Ok(cmd) if cmd.is_prebuilt() => cmd.describe(),
                Ok(cmd) => format!("{} (source checkout; needs a Rust toolchain)", cmd.describe()),
                Err(e) => format!("unavailable: {e}"),
            };
            (tool.label(), outcome)
        })
        .collect()
}

/// Find `tool`, honouring a configured `tool_dir` first and the running executable's directory
/// second, before falling back to the source checkout.
pub fn resolve(tool: Tool, tool_dir: Option<&str>) -> Result<ToolCommand> {
    if let Some(dir) = tool_dir.map(str::trim).filter(|d| !d.is_empty()) {
        let dir = PathBuf::from(dir);
        if let Some(program) = first_executable(&dir, tool.binaries()) {
            return Ok(ToolCommand { program, leading: Vec::new(), cwd: None, prebuilt: true });
        }
        bail!(
            "[ops] tool_dir is {} but it holds no {}. Expected one of: {}. Either put the \
             prebuilt binary there or remove tool_dir to build it from a source checkout.",
            dir.display(),
            tool.label(),
            tool.binaries().join(", ")
        );
    }

    if let Some(dir) = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_owned))
    {
        if let Some(program) = first_executable(&dir, tool.binaries()) {
            return Ok(ToolCommand { program, leading: Vec::new(), cwd: None, prebuilt: true });
        }
    }

    let root = repo_root().with_context(|| {
        format!(
            "no prebuilt {} next to the operator binary, and no source checkout above the \
             working directory to build one from. Set [ops] tool_dir to a directory holding \
             the operator's tool binaries.",
            tool.label()
        )
    })?;
    Ok(ToolCommand {
        program: PathBuf::from("cargo"),
        leading: tool.cargo_args().iter().map(|s| (*s).to_string()).collect(),
        // `--manifest-path zk/prover/Cargo.toml` and `-p input-exporter` are both relative to the
        // repo root. Anchoring the CHILD here is what stops the daemon's own working directory
        // from being load bearing (GOAL M1) without changing a single fallback argument.
        cwd: Some(root),
        prebuilt: false,
    })
}

/// The first of `names` that exists in `dir` and can be executed.
fn first_executable(dir: &Path, names: &[&str]) -> Option<PathBuf> {
    names.iter().map(|name| dir.join(name)).find(|path| is_executable(path))
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

/// Walk up from the working directory looking for this repository.
///
/// Both markers are required: `crates/input-exporter` is the root workspace the fallback's
/// `-p input-exporter` resolves against, and `zk/prover` is the detached workspace its
/// `--manifest-path` names. A directory with only one of them is not this repo.
fn repo_root() -> Option<PathBuf> {
    let mut dir = std::env::current_dir().ok()?;
    loop {
        if dir.join("crates/input-exporter/Cargo.toml").is_file()
            && dir.join("zk/prover/Cargo.toml").is_file()
        {
            return Some(dir);
        }
        if !dir.pop() {
            return None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[cfg(unix)]
    fn write_executable(dir: &Path, name: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        fs::write(&path, "#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[test]
    #[cfg(unix)]
    fn a_configured_tool_dir_wins_and_needs_no_compiler() {
        let dir = tempfile::tempdir().unwrap();
        let expected = write_executable(dir.path(), "input-exporter");
        let resolved =
            resolve(Tool::InputExporter, Some(dir.path().to_str().unwrap())).expect("resolves");
        assert!(resolved.is_prebuilt());
        assert_eq!(resolved.describe(), expected.display().to_string());
    }

    #[test]
    #[cfg(unix)]
    fn one_fat_prover_serves_both_feature_lanes() {
        let dir = tempfile::tempdir().unwrap();
        let expected = write_executable(dir.path(), "trustgraph-prover");
        for tool in [Tool::ProverFetch, Tool::ProverNostr] {
            let resolved = resolve(tool, Some(dir.path().to_str().unwrap())).expect("resolves");
            assert_eq!(resolved.describe(), expected.display().to_string());
        }
    }

    #[test]
    #[cfg(unix)]
    fn a_lane_specific_prover_is_preferred_over_the_generic_one() {
        let dir = tempfile::tempdir().unwrap();
        write_executable(dir.path(), "trustgraph-prover");
        let specific = write_executable(dir.path(), "trustgraph-prover-fetch");
        let resolved = resolve(Tool::ProverFetch, Some(dir.path().to_str().unwrap())).unwrap();
        assert_eq!(resolved.describe(), specific.display().to_string());
    }

    #[test]
    fn a_configured_tool_dir_that_is_missing_the_tool_is_an_error_not_a_cargo_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let error = resolve(Tool::InputExporter, Some(dir.path().to_str().unwrap()))
            .expect_err("an empty tool_dir must not silently fall back to a compiler");
        let text = error.to_string();
        assert!(text.contains("tool_dir"), "{text}");
        assert!(text.contains("input-exporter"), "{text}");
    }

    #[test]
    #[cfg(unix)]
    fn a_non_executable_file_of_the_right_name_does_not_count() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("input-exporter"), "not a program").unwrap();
        assert!(resolve(Tool::InputExporter, Some(dir.path().to_str().unwrap())).is_err());
    }

    #[test]
    #[cfg(unix)]
    fn the_startup_report_says_which_lanes_can_run_without_a_compiler() {
        let dir = tempfile::tempdir().unwrap();
        write_executable(dir.path(), "input-exporter");
        write_executable(dir.path(), "envelope0-preflight");
        let report = report(Some(dir.path().to_str().unwrap()));
        let by_name: std::collections::BTreeMap<_, _> = report.into_iter().collect();
        assert!(by_name["input-exporter"].ends_with("/input-exporter"), "{by_name:?}");
        // The prover lanes are absent from this deployment, and that is a report, not a refusal.
        assert!(by_name["trustgraph-prover-fetch"].starts_with("unavailable:"), "{by_name:?}");
    }

    #[test]
    fn an_unset_tool_dir_falls_back_to_the_source_checkout() {
        // The test binary runs inside this repository, so the upward walk finds it.
        let resolved = resolve(Tool::InputExporter, None).expect("the checkout is the fallback");
        assert!(!resolved.is_prebuilt());
        assert!(resolved.describe().starts_with("cargo run"), "{resolved:?}");
        assert!(resolved.describe().contains("-p input-exporter"));
    }

    #[test]
    fn the_blank_tool_dir_a_shell_heredoc_writes_is_treated_as_unset() {
        let resolved = resolve(Tool::InputExporter, Some("   ")).expect("blank means unset");
        assert!(!resolved.is_prebuilt());
    }

    #[test]
    fn the_fallback_keeps_every_argument_the_dev_loop_has_always_passed() {
        let fetch = resolve(Tool::ProverFetch, None).unwrap();
        assert!(fetch.describe().contains("--manifest-path zk/prover/Cargo.toml"), "{fetch:?}");
        assert!(fetch.describe().contains("--features fetch"), "{fetch:?}");
        let nostr = resolve(Tool::ProverNostr, None).unwrap();
        assert!(nostr.describe().contains("--features witness-nostr"), "{nostr:?}");
        let preflight = resolve(Tool::Envelope0Preflight, None).unwrap();
        assert!(preflight.describe().contains("--bin envelope0-preflight"), "{preflight:?}");
    }

    #[test]
    fn the_fallback_anchors_the_child_at_the_repo_root_so_cwd_is_not_load_bearing() {
        let resolved = resolve(Tool::ProverFetch, None).unwrap();
        let cwd = resolved.cwd.clone().expect("the fallback pins a working directory");
        assert!(cwd.join("zk/prover/Cargo.toml").is_file());
        assert!(cwd.join("crates/input-exporter/Cargo.toml").is_file());
    }

    #[test]
    fn every_spawned_child_is_told_not_to_rebuild_the_guests() {
        // A child that rebuilds the guests mid-tick returns a proof under a vkey no deployed
        // verifier pinned. This holds for the prebuilt path too, so the two modes differ in
        // exactly one thing: which executable runs.
        let dir = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        write_executable(dir.path(), "input-exporter");
        #[cfg(unix)]
        let resolved = resolve(Tool::InputExporter, Some(dir.path().to_str().unwrap())).unwrap();
        #[cfg(not(unix))]
        let resolved = resolve(Tool::InputExporter, None).unwrap();
        let cmd = resolved.command(["--help"]);
        let set = cmd
            .get_envs()
            .find(|(k, _)| *k == std::ffi::OsStr::new("SP1_SKIP_PROGRAM_BUILD"))
            .and_then(|(_, v)| v)
            .map(|v| v.to_string_lossy().to_string());
        assert_eq!(set.as_deref(), Some("true"));
    }
}
