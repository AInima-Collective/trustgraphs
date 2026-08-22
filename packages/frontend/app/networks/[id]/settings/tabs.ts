export const SETTINGS_TABS = [
  { id: 'overview', label: 'Overview', description: 'Health and actions' },
  {
    id: 'proofs',
    label: 'Proofs & billing',
    description: 'Service, balance, and activity',
  },
  {
    id: 'features',
    label: 'Features',
    description: 'Programs connected to this network',
  },
  {
    id: 'scoring',
    label: 'Scoring',
    description: 'Ranking policy and trusted inputs',
  },
  {
    id: 'access',
    label: 'Access',
    description: 'Roles, ownership, and authority',
  },
  {
    id: 'advanced',
    label: 'Advanced',
    description: 'Contracts and audit data',
  },
] as const

export type SettingsTab = (typeof SETTINGS_TABS)[number]['id']
