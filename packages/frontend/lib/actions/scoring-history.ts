type ParameterVersionAtBlock = {
  valid: boolean
  version: string
  executedAtBlock: string
}

const bigintOrUndefined = (value: string): bigint | undefined => {
  try {
    return BigInt(value)
  } catch {
    return undefined
  }
}

/** Select the last valid parameter version that existed when the proposal was created. */
export const selectProposalBaselineVersion = <
  Version extends ParameterVersionAtBlock,
>(
  versions: readonly Version[] | undefined,
  proposalBlock: bigint
): Version | undefined =>
  versions
    ?.filter((version) => {
      const executedAtBlock = bigintOrUndefined(version.executedAtBlock)
      const versionNumber = bigintOrUndefined(version.version)
      return (
        version.valid &&
        executedAtBlock !== undefined &&
        executedAtBlock >= 0n &&
        versionNumber !== undefined &&
        versionNumber >= 0n &&
        executedAtBlock <= proposalBlock
      )
    })
    .reduce<Version | undefined>((latest, version) => {
      if (!latest) return version
      const latestBlock = bigintOrUndefined(latest.executedAtBlock)!
      const candidateBlock = bigintOrUndefined(version.executedAtBlock)!
      if (candidateBlock !== latestBlock) {
        return candidateBlock > latestBlock ? version : latest
      }
      const latestVersion = bigintOrUndefined(latest.version)
      const candidateVersion = bigintOrUndefined(version.version)
      if (latestVersion === undefined || candidateVersion === undefined) {
        return latest
      }
      return candidateVersion > latestVersion ? version : latest
    }, undefined)
