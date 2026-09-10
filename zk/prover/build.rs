//! Build pinned, locked SP1 guests; local builds require an explicit development opt-in.
use sp1_build::{build_program_with_args, BuildArgs};
use std::path::PathBuf;

const BUILDER_IMAGE: &str = include_str!("../sp1-builder-image.txt");
const GUESTS: &[&str] = &[
    "../program",
    "../trust-graph-program",
    "../weighted-program",
    "../composition-program",
    "../nostr-program/program",
];

fn main() {
    // A host target override must not redirect guest ELF lookup. Guest archives use the detached
    // workspaces' standard target paths, also used by scripts/guest-elf-dirs.sh.
    std::env::remove_var("CARGO_TARGET_DIR");
    for name in [
        "TRUSTGRAPH_GUEST_BUILD",
        "TRUSTGRAPHS_RELEASE_BUILD",
        "SP1_DOCKER_IMAGE",
        "SP1_SKIP_PROGRAM_BUILD",
    ] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    let root =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("Cargo manifest directory"))
            .join("../..")
            .canonicalize()
            .expect("repository root");
    println!("cargo:rerun-if-changed={}", root.join("crates").display());
    println!("cargo:rerun-if-changed={}", root.join("zk/sp1-builder-image.txt").display());
    let mode = std::env::var("TRUSTGRAPH_GUEST_BUILD").unwrap_or_else(|_| "docker".into());
    assert!(mode == "docker" || mode == "local", "TRUSTGRAPH_GUEST_BUILD must be docker or local");
    let docker = mode == "docker";
    assert!(
        docker || std::env::var("TRUSTGRAPHS_RELEASE_BUILD").as_deref() != Ok("1"),
        "Release builds require Docker guest artifacts"
    );
    let image = BUILDER_IMAGE.trim();
    if docker {
        if let Ok(override_image) = std::env::var("SP1_DOCKER_IMAGE") {
            assert_eq!(
                override_image, image,
                "SP1_DOCKER_IMAGE must match zk/sp1-builder-image.txt"
            );
        }
        std::env::set_var("SP1_DOCKER_IMAGE", image);
    } else {
        println!("cargo:warning=Development-only local guests: these vkeys must not be deployed");
    }
    println!("cargo:rustc-env=TRUSTGRAPHS_GUEST_BUILD={mode}");
    for path in GUESTS {
        for input in ["src", "Cargo.toml", "Cargo.lock"] {
            println!("cargo:rerun-if-changed={path}/{input}");
        }
        let workspace = std::process::Command::new("cargo")
            .args(["locate-project", "--workspace", "--message-format", "plain", "--manifest-path"])
            .arg(format!("{path}/Cargo.toml"))
            .output()
            .expect("locate detached workspace");
        assert!(workspace.status.success(), "Cannot locate guest workspace: {path}");
        let workspace_manifest =
            PathBuf::from(String::from_utf8(workspace.stdout).expect("UTF-8 path").trim());
        println!("cargo:rerun-if-changed={}", workspace_manifest.display());
        println!(
            "cargo:rerun-if-changed={}",
            workspace_manifest.with_file_name("Cargo.lock").display()
        );
        // SP1's metadata discovery runs before its build arguments. Verify the detached lockfile
        // first, so that discovery cannot silently resolve an unlocked dependency graph.
        let status =
            std::process::Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()))
                .args(["metadata", "--locked", "--format-version", "1", "--manifest-path"])
                .arg(format!("{path}/Cargo.toml"))
                .stdout(std::process::Stdio::null())
                .status()
                .expect("validate guest lockfile");
        assert!(status.success(), "Guest lockfile must be current: {path}");
        build_program_with_args(
            path,
            BuildArgs {
                docker,
                locked: true,
                tag: image
                    .strip_prefix("ghcr.io/succinctlabs/sp1:")
                    .expect("pinned SP1 image")
                    .into(),
                workspace_directory: Some(root.display().to_string()),
                ..Default::default()
            },
        );
    }
    let artifacts = std::process::Command::new("sh")
        .args(["scripts/guest-elf-dirs.sh", "--files"])
        .current_dir(&root)
        .output()
        .expect("locate guest artifacts");
    assert!(artifacts.status.success(), "Missing guest artifacts; run scripts/build-guests.sh");
    for path in String::from_utf8(artifacts.stdout).expect("UTF-8 artifact paths").lines() {
        println!("cargo:rerun-if-changed={}", root.join(path).display());
    }
}
