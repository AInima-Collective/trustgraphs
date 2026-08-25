export interface LoadTargetEnvironmentOptions {
  repositoryRoot: string
  environment?: NodeJS.ProcessEnv
  higherPriorityFiles?: string[]
  target?: string
  createBaseFrom?: string
}

export interface LoadedTargetEnvironment {
  environment: Record<string, string>
  parsed: Record<string, string>
  target: string
  files: string[]
}

export function loadTargetEnvironment(
  options: LoadTargetEnvironmentOptions
): LoadedTargetEnvironment
