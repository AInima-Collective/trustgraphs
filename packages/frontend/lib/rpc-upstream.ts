export const rpcUpstreamUrl = (
  chainId: string,
  endpointId: number,
  environment: Readonly<Record<string, string | undefined>> = process.env
): string | undefined =>
  environment[`RPC_URL_${chainId}_${endpointId}`] ||
  (endpointId === 0 ? environment[`RPC_URL_${chainId}`] : undefined)
