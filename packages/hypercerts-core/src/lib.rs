//! hypercerts-core — the hypercerts program's semantics: @hypercerts-org/lexicon v1.1.0
//! records → trust edges (HYPERCERTS_ATPROTO_PLAN §2–§3), node identity (bound / satellite /
//! artifact), Params/Journal, and every byte encoding this program owns. Single source of
//! truth for the hypercerts SP1 guest, the host, and the TS view — same discipline as
//! `pagerank-core`: NO floats, BTree-only iteration, deterministic everything.

pub mod binding;
pub mod decimal;
pub mod records;
pub mod semantics;
