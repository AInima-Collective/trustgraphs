export const SETTINGS_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'proofs', label: 'Proofs & billing' },
  { id: 'features', label: 'Features' },
  { id: 'scoring', label: 'Scoring' },
  { id: 'access', label: 'Access' },
  { id: 'advanced', label: 'Advanced' },
] as const

export type SettingsTab = (typeof SETTINGS_TABS)[number]['id']
