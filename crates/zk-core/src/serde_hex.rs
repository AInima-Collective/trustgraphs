//! Serde helper for `Vec<u8>` fields: a `0x`-hex string in human-readable formats (JSON —
//! what input files and fixtures use), raw bytes otherwise (bincode — the host→guest stream).

use serde::{Deserialize, Deserializer, Serializer};

pub fn serialize<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
    if serializer.is_human_readable() {
        serializer.serialize_str(&format!("0x{}", alloy_primitives::hex::encode(bytes)))
    } else {
        serializer.serialize_bytes(bytes)
    }
}

pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
    if deserializer.is_human_readable() {
        let value = String::deserialize(deserializer)?;
        let value = value.strip_prefix("0x").unwrap_or(&value);
        alloy_primitives::hex::decode(value).map_err(serde::de::Error::custom)
    } else {
        serde_bytes::ByteBuf::deserialize(deserializer).map(serde_bytes::ByteBuf::into_vec)
    }
}
