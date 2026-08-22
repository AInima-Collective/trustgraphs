import { atom } from 'jotai'

export type Breadcrumb = {
  title: string
  route: string
}

/** Active breadcrumbs. */
export const breadcrumbsAtom = atom<Breadcrumb[]>([])
