import {
  type ScoringPreviewInput,
  previewScoringChange,
} from '../lib/scoring-preview'

self.onmessage = (event: MessageEvent<ScoringPreviewInput>) => {
  try {
    self.postMessage({ preview: previewScoringChange(event.data) })
  } catch (error) {
    self.postMessage({
      error:
        error instanceof Error ? error.message : 'The scoring preview failed.',
    })
  }
}
