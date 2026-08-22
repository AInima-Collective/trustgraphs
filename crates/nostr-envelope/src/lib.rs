#![forbid(unsafe_code)]

// Keep the consensus implementation in the goal-mandated Envelope-2 source tree while compiling
// it as an isolated crate. Existing SP1 programs depend on `envelopes`; changing that crate's
// manifest or module graph rotates their verification keys even when a new feature is disabled.
#[path = "../../envelopes/src/nostr/mod.rs"]
pub mod nostr;
