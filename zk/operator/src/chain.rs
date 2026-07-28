//! The RPC side: reads that build an `InstanceState`, and the two writes that cost money.
//!
//! Everything here is mechanical. Every decision is in `operator-core`.

use alloy_primitives::{keccak256, Address, B256, U256};
use alloy_sol_types::{sol, SolCall, SolEvent, SolValue};
use anyhow::{anyhow, bail, Context, Result};
use operator_core::catalog::{ChainReader, CreatedParams, RegistryRecord};
use operator_core::types::{CheckpointRef, Commitments};
use pagerank_core::Params;
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::BTreeMap;

sol! {
    /// Mirror of `ParamsCodec.Params` (params schema v2 — 17 fields, order FROZEN).
    struct SolParams {
        uint256 dampingFp; uint256 toleranceFp; uint32 maxIterations; uint256 minWeightFp;
        uint256 maxWeightFp; uint256 trustMultiplierFp; uint256 trustShareFp; uint256 trustDecayFp;
        address[] trustedSeeds; uint256 totalPool; uint256 precisionScale; bytes32 schemaUid;
        uint32 weightFieldIndex; bytes32[] envelope0DomainSeparators; uint64 lane2MaxHeadAge;
        address accumulator; uint64 chainId;
    }

    event InstanceCreated(
        bytes32 indexed instanceId, address indexed creator, address indexed admin,
        string name, string metadataURI, address resolver, bytes32 schemaUid, address snapshot,
        address distributor, address distributorToken, uint64 epochLength, SolParams params
    );

    struct Instance {
        bytes32 program; address snapshot; address verifier;
        address registryOrAccumulator; bytes32 paramsHash;
    }
    event InstanceRegistered(
        bytes32 indexed instanceId, bytes32 indexed program, address snapshot, address verifier,
        address registryOrAccumulator, bytes32 paramsHash
    );
    function getInstanceIds() external view returns (bytes32[]);
    function getInstance(bytes32 instanceId) external view returns (Instance);

    /// `MerkleSnapshot` — journal v3.
    function paramsHash() external view returns (bytes32);
    function checkpointParamsHash(uint256 checkpointId) external view returns (bytes32);
    function epochLength() external view returns (uint64);
    function lastTriggerBlock() external view returns (uint64);
    function hasAppliedCheckpoint() external view returns (bool);
    function lastAppliedCheckpoint() external view returns (uint256);
    function zkVerifier() external view returns (address);
    function accumulator() external view returns (address);
    function anchorRegistry() external view returns (address);
    function anchorCheckpoints(uint256 checkpointId) external view returns (bytes32 anchorAcc, uint64 anchorCount);
    function instanceDomain() external view returns (bytes32);
    function trigger() external returns (uint256);
    function submitProof(
        uint256 checkpointId, bytes32 outputRoot, bytes32 ipfsHash, string ipfsHashCid,
        uint256 totalValue, bytes32 skippedDigest, address recipient, bytes proof
    ) external;

    /// `AttestationAccumulator`.
    struct Checkpoint { bytes32 acc; uint64 leafCount; uint64 blockNumber; }
    function leafCount() external view returns (uint64);
    function checkpointCount() external view returns (uint256);
    function getCheckpoint(uint256 id) external view returns (Checkpoint);
    function acc() external view returns (bytes32);

    /// `AnchorRegistry`.
    function anchorAcc() external view returns (bytes32);
    function anchorCount() external view returns (uint64);

    /// `TrustGraphFactory`.
    function EAS() external view returns (address);

    /// `SP1JournalVerifier`.
    function programVKey() external view returns (bytes32);

    /// `ProvingVault` — the funded path. Mirrors `IProvingVault.SubmitArgs` exactly.
    struct SubmitArgs {
        uint256 checkpointId; bytes32 outputRoot; bytes32 ipfsHash; string ipfsHashCid;
        uint256 totalValue; bytes32 skippedDigest; address recipient; bytes proof;
        uint256 minPayoutUsd;
    }
    function submitAndClaim(bytes32 instanceId, SubmitArgs args)
        external returns (uint256 feeUsd, uint256 gasUsd);
}

pub struct Rpc {
    client: reqwest::blocking::Client,
    url: String,
    /// One factory `EAS()` read serves every instance it minted.
    eas_cache: RefCell<BTreeMap<Address, Address>>,
}

impl Rpc {
    pub fn new(url: String) -> Self {
        Self {
            client: reqwest::blocking::Client::new(),
            url,
            eas_cache: RefCell::new(BTreeMap::new()),
        }
    }

    /// One JSON-RPC round trip. `pub(crate)` because `tx.rs` extends `Rpc` with the write-side
    /// methods and needs the same transport rather than a second one.
    pub(crate) fn call(&self, method: &str, params: Value) -> Result<Value> {
        let body = json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params});
        let resp: Value = self
            .client
            .post(&self.url)
            .json(&body)
            .send()?
            .json()
            .with_context(|| format!("{method}: response was not JSON"))?;
        if let Some(e) = resp.get("error").filter(|e| !e.is_null()) {
            bail!("{method} RPC error: {e}");
        }
        Ok(resp.get("result").cloned().unwrap_or(Value::Null))
    }

    fn hex_u64(v: &Value) -> Result<u64> {
        let s = v.as_str().ok_or_else(|| anyhow!("expected a hex string, got {v}"))?;
        Ok(u64::from_str_radix(s.trim_start_matches("0x"), 16)?)
    }

    pub fn eth_chain_id(&self) -> Result<u64> {
        Self::hex_u64(&self.call("eth_chainId", json!([]))?)
    }

    pub fn block_number(&self) -> Result<u64> {
        Self::hex_u64(&self.call("eth_blockNumber", json!([]))?)
    }

    /// Head basefee, in wei. Absent (pre-1559 or a chain that omits it) reads as zero, which can
    /// only make the basefee gate more permissive — and on such a chain the gate is meaningless
    /// anyway.
    pub fn basefee(&self) -> Result<u128> {
        let b = self.call("eth_getBlockByNumber", json!(["latest", false]))?;
        match b.get("baseFeePerGas").and_then(|v| v.as_str()) {
            Some(s) => Ok(u128::from_str_radix(s.trim_start_matches("0x"), 16)?),
            None => Ok(0),
        }
    }

    pub fn block_hash(&self, number: u64) -> Result<Option<B256>> {
        let b = self.call("eth_getBlockByNumber", json!([format!("0x{number:x}"), false]))?;
        Ok(b.get("hash").and_then(|v| v.as_str()).and_then(|s| {
            s.trim_start_matches("0x").parse::<B256>().ok().or_else(|| {
                hex::decode(s.trim_start_matches("0x"))
                    .ok()
                    .and_then(|b| (b.len() == 32).then(|| B256::from_slice(&b)))
            })
        }))
    }

    pub fn eth_call(&self, to: Address, data: Vec<u8>) -> Result<Vec<u8>> {
        let params = json!([{ "to": to, "data": format!("0x{}", hex::encode(&data)) }, "latest"]);
        let r = self.call("eth_call", params)?;
        let s = r.as_str().ok_or_else(|| anyhow!("eth_call returned no data"))?;
        Ok(hex::decode(s.trim_start_matches("0x"))?)
    }

    /// Simulate a state-changing call from `from`. A revert here is a hold, not a broadcast: it is
    /// the difference between noticing a paused instance and paying to discover it.
    pub fn simulate(&self, from: Address, to: Address, data: &[u8]) -> Result<()> {
        let params = json!([
            { "from": from, "to": to, "data": format!("0x{}", hex::encode(data)) },
            "latest"
        ]);
        self.call("eth_call", params).map(|_| ())
    }

    pub fn logs(
        &self,
        address: Address,
        topic0: B256,
        from: u64,
        to: u64,
        chunk: u64,
    ) -> Result<Vec<RawLog>> {
        let mut out = Vec::new();
        let mut start = from;
        while start <= to {
            let end = (start.saturating_add(chunk.saturating_sub(1))).min(to);
            let params = json!([{
                "address": address,
                "topics": [format!("0x{}", hex::encode(topic0))],
                "fromBlock": format!("0x{start:x}"),
                "toBlock": format!("0x{end:x}"),
            }]);
            let r = self.call("eth_getLogs", params)?;
            for log in r.as_array().ok_or_else(|| anyhow!("eth_getLogs non-array"))? {
                out.push(RawLog::parse(log)?);
            }
            if end == to {
                break;
            }
            start = end + 1;
        }
        Ok(out)
    }

    pub fn receipt_logs(&self, tx: B256) -> Result<Vec<RawLog>> {
        let r =
            self.call("eth_getTransactionReceipt", json!([format!("0x{}", hex::encode(tx))]))?;
        let logs = r.get("logs").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        logs.iter().map(RawLog::parse).collect()
    }
}

pub struct RawLog {
    pub address: Address,
    pub topics: Vec<B256>,
    pub data: Vec<u8>,
    pub block_number: u64,
    pub transaction_hash: B256,
}

impl RawLog {
    fn parse(v: &Value) -> Result<Self> {
        let h = |s: &str| -> Result<B256> {
            let b = hex::decode(s.trim_start_matches("0x"))?;
            anyhow::ensure!(b.len() == 32, "expected a 32-byte value, got {} bytes", b.len());
            Ok(B256::from_slice(&b))
        };
        Ok(Self {
            address: v["address"].as_str().unwrap_or_default().parse()?,
            topics: v["topics"]
                .as_array()
                .map(|a| a.iter().filter_map(|t| t.as_str()).map(h).collect::<Result<Vec<_>>>())
                .transpose()?
                .unwrap_or_default(),
            data: hex::decode(v["data"].as_str().unwrap_or("0x").trim_start_matches("0x"))?,
            block_number: v["blockNumber"]
                .as_str()
                .map(|s| u64::from_str_radix(s.trim_start_matches("0x"), 16))
                .transpose()?
                .unwrap_or(0),
            transaction_hash: h(v["transactionHash"].as_str().unwrap_or_default())?,
        })
    }
}

/// `operator-core`'s catalog, over live RPC.
pub struct RpcCatalog<'a> {
    pub rpc: &'a Rpc,
    pub registry: Address,
    /// instance id -> the transaction that registered it. Built once per scan.
    pub registered_in: BTreeMap<B256, (u64, B256)>,
}

impl<'a> RpcCatalog<'a> {
    pub fn new(rpc: &'a Rpc, registry: Address, from_block: u64) -> Result<Self> {
        let head = rpc.block_number()?;
        let logs =
            rpc.logs(registry, InstanceRegistered::SIGNATURE_HASH, from_block, head, 10_000)?;
        let mut registered_in = BTreeMap::new();
        for log in &logs {
            if let Some(id) = log.topics.get(1) {
                // First registration wins; `update()` emits a different event.
                registered_in.entry(*id).or_insert((log.block_number, log.transaction_hash));
            }
        }
        Ok(Self { rpc, registry, registered_in })
    }
}

impl ChainReader for RpcCatalog<'_> {
    type Error = anyhow::Error;

    fn chain_id(&self) -> Result<u64> {
        self.rpc.eth_chain_id()
    }

    fn instance_ids(&self) -> Result<Vec<B256>> {
        let ret = self.rpc.eth_call(self.registry, getInstanceIdsCall {}.abi_encode())?;
        Ok(getInstanceIdsCall::abi_decode_returns(&ret)?)
    }

    fn instance_record(&self, id: B256) -> Result<RegistryRecord> {
        let ret =
            self.rpc.eth_call(self.registry, getInstanceCall { instanceId: id }.abi_encode())?;
        let r = getInstanceCall::abi_decode_returns(&ret)?;
        Ok(RegistryRecord {
            program: r.program,
            snapshot: r.snapshot,
            verifier: r.verifier,
            registry_or_accumulator: r.registryOrAccumulator,
            params_hash: r.paramsHash,
        })
    }

    fn created_params(&self, id: B256) -> Result<Option<CreatedParams>> {
        let Some((created_block, tx)) = self.registered_in.get(&id).copied() else {
            return Ok(None);
        };
        let logs = self.rpc.receipt_logs(tx)?;
        let Some(log) = logs.iter().find(|l| {
            l.topics.first() == Some(&InstanceCreated::SIGNATURE_HASH)
                && l.topics.get(1) == Some(&id)
        }) else {
            return Ok(None);
        };
        let ev = InstanceCreated::decode_raw_log(log.topics.iter().copied(), &log.data)?;
        Ok(Some(CreatedParams {
            factory: log.address,
            name: ev.name.clone(),
            snapshot: ev.snapshot,
            resolver: ev.resolver,
            created_block,
            params: to_core_params(&ev.params),
        }))
    }

    fn snapshot_params_hash(&self, snapshot: Address) -> Result<B256> {
        let ret = self.rpc.eth_call(snapshot, paramsHashCall {}.abi_encode())?;
        Ok(paramsHashCall::abi_decode_returns(&ret)?)
    }

    fn factory_eas(&self, factory: Address) -> Result<Address> {
        if let Some(a) = self.rpc.eas_cache.borrow().get(&factory) {
            return Ok(*a);
        }
        let ret = self.rpc.eth_call(factory, EASCall {}.abi_encode())?;
        let a = EASCall::abi_decode_returns(&ret)?;
        self.rpc.eas_cache.borrow_mut().insert(factory, a);
        Ok(a)
    }
}

fn to_core_params(p: &SolParams) -> Params {
    Params {
        damping_fp: p.dampingFp,
        tolerance_fp: p.toleranceFp,
        max_iterations: p.maxIterations,
        min_weight_fp: p.minWeightFp,
        max_weight_fp: p.maxWeightFp,
        trust_multiplier_fp: p.trustMultiplierFp,
        trust_share_fp: p.trustShareFp,
        trust_decay_fp: p.trustDecayFp,
        trusted_seeds: p.trustedSeeds.clone(),
        total_pool: p.totalPool,
        precision_scale: p.precisionScale,
        schema_uid: p.schemaUid,
        weight_field_index: p.weightFieldIndex,
        envelope0_domain_separators: p.envelope0DomainSeparators.clone(),
        lane2_max_head_age: p.lane2MaxHeadAge,
        accumulator: p.accumulator,
        chain_id: p.chainId,
    }
}

/// Everything an `InstanceState` needs from one snapshot, read in one place.
pub struct SnapshotView {
    pub params_hash: B256,
    pub zk_verifier: Address,
    /// Read off the snapshot rather than the registry row: `setAccumulator` is constitutional and
    /// the directory copy may lag it, and proving against the wrong lane is unrecoverable.
    pub accumulator: Address,
    pub anchor_registry: Address,
    pub epoch_length: u64,
    pub last_trigger_block: u64,
    pub last_applied: Option<u64>,
    pub instance_domain: B256,
    pub checkpoints: Vec<CheckpointRef>,
    pub live: Commitments,
}

/// How many trailing checkpoints to read. Only the newest unproven one is ever proved, so a full
/// history walk would be pure RPC cost — but reading a few gives the coalescing branch something
/// to coalesce and makes a stale `lastApplied` visible.
const CHECKPOINT_WINDOW: u64 = 8;

pub fn read_snapshot(rpc: &Rpc, snapshot: Address) -> Result<SnapshotView> {
    let b32 = |data: Vec<u8>| -> Result<B256> {
        let ret = rpc.eth_call(snapshot, data)?;
        Ok(B256::from_slice(&ret[..32]))
    };
    let addr = |data: Vec<u8>| -> Result<Address> {
        let ret = rpc.eth_call(snapshot, data)?;
        Ok(Address::from_slice(&ret[12..32]))
    };
    let u64v = |data: Vec<u8>| -> Result<u64> {
        let ret = rpc.eth_call(snapshot, data)?;
        Ok(U256::from_be_slice(&ret[..32]).to::<u64>())
    };

    let params_hash = b32(paramsHashCall {}.abi_encode())?;
    let zk_verifier = addr(zkVerifierCall {}.abi_encode())?;
    let accumulator = addr(accumulatorCall {}.abi_encode())?;
    let anchor_registry = addr(anchorRegistryCall {}.abi_encode())?;
    let epoch_length = u64v(epochLengthCall {}.abi_encode())?;
    let last_trigger_block = u64v(lastTriggerBlockCall {}.abi_encode())?;
    let instance_domain = b32(instanceDomainCall {}.abi_encode())?;

    let has_applied = {
        let ret = rpc.eth_call(snapshot, hasAppliedCheckpointCall {}.abi_encode())?;
        ret.last().is_some_and(|b| *b == 1)
    };
    let last_applied =
        if has_applied { Some(u64v(lastAppliedCheckpointCall {}.abi_encode())?) } else { None };

    // Checkpoints, newest-window only.
    let count = {
        let ret = rpc.eth_call(accumulator, checkpointCountCall {}.abi_encode())?;
        U256::from_be_slice(&ret[..32]).to::<u64>()
    };
    let mut checkpoints = Vec::new();
    let start = count.saturating_sub(CHECKPOINT_WINDOW);
    for id in start..count {
        let ret = rpc
            .eth_call(accumulator, getCheckpointCall { id: U256::from(id) }.abi_encode())
            .with_context(|| format!("getCheckpoint({id})"))?;
        let c = getCheckpointCall::abi_decode_returns(&ret)?;
        let ac = {
            let r = rpc.eth_call(
                snapshot,
                anchorCheckpointsCall { checkpointId: U256::from(id) }.abi_encode(),
            )?;
            anchorCheckpointsCall::abi_decode_returns(&r)?
        };
        let pinned = {
            let r = rpc.eth_call(
                snapshot,
                checkpointParamsHashCall { checkpointId: U256::from(id) }.abi_encode(),
            )?;
            let h = B256::from_slice(&r[..32]);
            // Zero is the "not pinned" sentinel: this checkpoint was minted outside `trigger()`
            // and `submitProof` would revert `UnpinnedCheckpoint`.
            (h != B256::ZERO).then_some(h)
        };
        checkpoints.push(CheckpointRef {
            id,
            block_number: c.blockNumber,
            commitments: Commitments {
                acc: c.acc,
                leaf_count: c.leafCount,
                anchor_acc: ac.anchorAcc,
                anchor_count: ac.anchorCount,
            },
            pinned_params_hash: pinned,
        });
    }

    // Live commitments, for the quiet check.
    let live_acc = {
        let r = rpc.eth_call(accumulator, accCall {}.abi_encode())?;
        B256::from_slice(&r[..32])
    };
    let live_leaves = {
        let r = rpc.eth_call(accumulator, leafCountCall {}.abi_encode())?;
        U256::from_be_slice(&r[..32]).to::<u64>()
    };
    let (live_anchor_acc, live_anchor_count) = if anchor_registry == Address::ZERO {
        (B256::ZERO, 0u64)
    } else {
        let a = rpc.eth_call(anchor_registry, anchorAccCall {}.abi_encode())?;
        let n = rpc.eth_call(anchor_registry, anchorCountCall {}.abi_encode())?;
        (B256::from_slice(&a[..32]), U256::from_be_slice(&n[..32]).to::<u64>())
    };

    Ok(SnapshotView {
        params_hash,
        zk_verifier,
        accumulator,
        anchor_registry,
        epoch_length,
        last_trigger_block,
        last_applied,
        instance_domain,
        checkpoints,
        live: Commitments {
            acc: live_acc,
            leaf_count: live_leaves,
            anchor_acc: live_anchor_acc,
            anchor_count: live_anchor_count,
        },
    })
}

/// The vkey a deployed verifier is pinned to. Checked at startup against the guest this binary was
/// built from, so a mismatch is a refusal to start rather than a failed submit later.
pub fn verifier_vkey(rpc: &Rpc, verifier: Address) -> Result<B256> {
    let ret = rpc.eth_call(verifier, programVKeyCall {}.abi_encode())?;
    Ok(B256::from_slice(&ret[..32]))
}

/// Calldata for `trigger()`.
pub fn trigger_calldata() -> Vec<u8> {
    triggerCall {}.abi_encode()
}

/// Calldata for journal-v3 `submitProof`.
#[allow(clippy::too_many_arguments)]
pub fn submit_calldata(
    checkpoint_id: u64,
    output_root: B256,
    ipfs_hash: B256,
    cid: String,
    total_value: U256,
    skipped_digest: B256,
    recipient: Address,
    proof: Vec<u8>,
) -> Vec<u8> {
    submitProofCall {
        checkpointId: U256::from(checkpoint_id),
        outputRoot: output_root,
        ipfsHash: ipfs_hash,
        ipfsHashCid: cid,
        totalValue: total_value,
        skippedDigest: skipped_digest,
        recipient,
        proof: proof.into(),
    }
    .abi_encode()
}

/// Calldata for the funded path: `ProvingVault.submitAndClaim`.
///
/// `minPayoutUsd` is the prover's own guard and the reason this is not just `submitProof` with a
/// wrapper. Below it the whole call reverts, so a community that zeroes its policy in the same
/// block gets a reverted transaction rather than a free root — and the checkpoint stays claimable.
#[allow(clippy::too_many_arguments)]
pub fn submit_and_claim_calldata(
    instance_id: B256,
    checkpoint_id: u64,
    output_root: B256,
    ipfs_hash: B256,
    cid: String,
    total_value: U256,
    skipped_digest: B256,
    recipient: Address,
    proof: Vec<u8>,
    min_payout_usd: U256,
) -> Vec<u8> {
    submitAndClaimCall {
        instanceId: instance_id,
        args: SubmitArgs {
            checkpointId: U256::from(checkpoint_id),
            outputRoot: output_root,
            ipfsHash: ipfs_hash,
            ipfsHashCid: cid,
            totalValue: total_value,
            skippedDigest: skipped_digest,
            recipient,
            proof: proof.into(),
            minPayoutUsd: min_payout_usd,
        },
    }
    .abi_encode()
}

/// The domain the journal must commit for this instance, derived exactly as `submitProof` rebuilds
/// it. Read from the contract when possible; this is the local check that the two agree.
pub fn expected_instance_domain(snapshot: Address, chain_id: u64) -> B256 {
    keccak256((snapshot, U256::from(chain_id)).abi_encode())
}
