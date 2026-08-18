import { parseAbi } from 'viem'

export const graphLineageRegistryAbi = parseAbi([
  'event LineageRegistered(bytes32 indexed lineageId,bytes32 indexed instanceId,address indexed authority,address controller,bytes32 familyId,string displayName,string metadataURI)',
  'event LineageMetadataUpdated(bytes32 indexed lineageId,address indexed authority,string displayName,string metadataURI)',
  'event ConfigurationActivated(bytes32 indexed lineageId,bytes32 indexed configurationId,uint64 indexed version,bytes32 programId,address snapshot,address verifier,address registryOrAccumulator,bytes32 paramsHash,address controller,address authority,bytes32 familyId,bytes32 methodId,bytes32 scopeHash,bytes32 identityDomain,bytes32 sourceLineagePolicyHash)',
  'event EpochPublished(bytes32 indexed lineageId,bytes32 indexed epochId,bytes32 indexed configurationId,uint64 configurationVersion,uint256 checkpointId,uint256 freezeBlock,uint256 acceptedAtBlock,bytes32 root,bytes32 blobSha256,bytes32 cidDigest,string cid,uint256 totalValue,bytes32 programVKey)',
  'event EndorsementIssued(bytes32 indexed endorsementId,bytes32 indexed issuerLineageId,bytes32 indexed subjectLineageId,bytes32 issuerConfigurationId,bytes32 subjectConfigurationId,bytes32 scopeHash,uint8 kind,uint256 weight,uint48 validFrom,uint48 validUntil,string evidenceURI,bytes32 evidenceDigest,uint64 sequence,bytes32 supersedes)',
  'event EndorsementRevoked(bytes32 indexed endorsementId,bytes32 indexed issuerLineageId,bytes32 indexed revocationRef,uint48 revokedAt)',
  'function instanceRegistry() view returns (address)',
  'function configurationLive(bytes32 configurationId) view returns (bool)',
  'function endorsementStatus(bytes32 endorsementId,bytes32 expectedScope,bytes32 expectedSubjectConfigurationId) view returns (uint8)',
])
