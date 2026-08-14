/// <reference lib="webworker" />

import type { WeightedImportArtifacts } from './import'
import { runWeightedPreview } from './preview'

export type WeightedPreviewWorkerRequest = {
  id: number
  artifacts: WeightedImportArtifacts
}

export type WeightedPreviewWorkerResponse =
  | { id: number; phase: 'starting' }
  | { id: number; phase: 'iterating' }
  | {
      id: number
      phase: 'complete'
      elapsedMs: number
      scores: Array<[string, string]>
      iterations: number
      outputRoot: string
    }
  | { id: number; phase: 'error'; error: string }

self.onmessage = (message: MessageEvent<WeightedPreviewWorkerRequest>) => {
  const { id, artifacts } = message.data
  self.postMessage({
    id,
    phase: 'starting',
  } satisfies WeightedPreviewWorkerResponse)
  try {
    self.postMessage({
      id,
      phase: 'iterating',
    } satisfies WeightedPreviewWorkerResponse)
    const started = performance.now()
    const result = runWeightedPreview(artifacts)
    self.postMessage({
      id,
      phase: 'complete',
      elapsedMs: performance.now() - started,
      scores: result.scores.map(([account, weight]) => [
        account,
        weight.toString(),
      ]),
      iterations: result.iterations,
      outputRoot: result.journal.outputRoot,
    } satisfies WeightedPreviewWorkerResponse)
  } catch (error) {
    self.postMessage({
      id,
      phase: 'error',
      error: error instanceof Error ? error.message : String(error),
    } satisfies WeightedPreviewWorkerResponse)
  }
}

export {}
