export type ParameterVersionState =
  | 'current-unpinned'
  | 'active'
  | 'superseded'
  | 'inconsistent'

type VersionLike = {
  version: bigint
  firstCheckpoint: bigint | null
  valid: boolean
}

/** Apply IF-3's exact activation semantics to an append-only version list. */
export const deriveParameterVersionStates = (
  versions: readonly VersionLike[],
  currentVersion: bigint | null
) => {
  const activeVersion = versions
    .filter((version) => version.valid && version.firstCheckpoint !== null)
    .reduce<
      bigint | null
    >((latest, version) => (latest === null || version.version > latest ? version.version : latest), null)

  return new Map<bigint, ParameterVersionState>(
    versions.map((version) => [
      version.version,
      !version.valid
        ? 'inconsistent'
        : activeVersion === version.version
          ? 'active'
          : currentVersion === version.version &&
              version.firstCheckpoint === null
            ? 'current-unpinned'
            : 'superseded',
    ])
  )
}
