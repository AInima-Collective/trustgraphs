import assert from 'node:assert/strict'

import { collectCatalogPages } from './catalog-pagination'

type Row = { id: string }

const row = (index: number): Row => ({ id: `row-${index}` })

const main = async () => {
  const allRows = Array.from({ length: 450 }, (_, index) => row(index))
  const offsets: number[] = []
  const complete = await collectCatalogPages<Row>(async (offset) => {
    offsets.push(offset)
    return {
      instances: allRows.slice(offset, offset + 200),
      pagination: { limit: 200, offset, total: allRows.length },
    }
  })

  assert.deepEqual(offsets, [0, 200, 400])
  assert.equal(complete.instances.length, 450)
  assert.equal(complete.instances[200]?.id, 'row-200')
  assert.deepEqual(complete.pagination, { limit: 200, offset: 0, total: 450 })

  await assert.rejects(
    collectCatalogPages<Row>(async (offset) => ({
      instances: Array.from({ length: 200 }, (_, index) => row(offset + index)),
      pagination: { limit: 200, offset, total: offset === 0 ? 201 : 202 },
    })),
    /total changed during pagination/
  )

  await assert.rejects(
    collectCatalogPages<Row>(async (offset) => ({
      instances:
        offset === 0
          ? Array.from({ length: 200 }, (_, index) => row(index))
          : [row(199)],
      pagination: { limit: 200, offset, total: 201 },
    })),
    /repeated row row-199/
  )

  await assert.rejects(
    collectCatalogPages<Row>(async (offset) => ({
      instances:
        offset === 0
          ? Array.from({ length: 200 }, (_, index) => row(index))
          : [],
      pagination: { limit: 200, offset, total: 201 },
    })),
    /made no progress at offset 200/
  )

  console.log('Catalog pagination tests passed')
}

void main()
