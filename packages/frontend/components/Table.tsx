'use client'

import { useMemo, useState } from 'react'

import { cn } from '@/lib/utils'

import { InfoTooltip } from './InfoTooltip'

export interface Column<T> {
  /** Unique key for the column */
  key: string
  /** Display header text */
  header: string
  /** Optional tooltip for the column header */
  tooltip?: string
  /** Whether this column is sortable */
  sortable?: boolean
  /** Custom sort function. If not provided but sortable is true, will use default comparison */
  sortFn?: (a: T, b: T, direction: 'asc' | 'desc') => number
  /** Custom render function for the cell. If not provided, will display the value directly (from accessor) */
  render?: (row: T) => React.ReactNode
  /** Custom className for the cell */
  cellClassName?: string | ((row: T) => string)
  /** Custom className for the header */
  headerClassName?: string
  /** Accessor function to get the value from the row for default sorting/rendering (required if render is not provided) */
  accessor?: (row: T) => any
}

export interface TableProps<T> {
  /** Column definitions */
  columns: Column<T>[]
  /** Data rows */
  data: T[]
  /** Optional click handler for rows */
  onRowClick?: (row: T) => void
  /** Function to get unique key for each row */
  getRowKey: (row: T) => string
  /** Optional custom className for rows */
  rowClassName?: string | ((row: T) => string)
  /** Optional custom className for the table container */
  className?: string
  /** Optional title for the row click action */
  rowClickTitle?: string
  /** Optional custom className for all cells */
  cellClassName?: string
  /** Optional custom className for all cells in a row */
  rowCellClassName?: (row: T) => string
  /** Default sort column */
  defaultSortColumn?: string
  /** Default sort direction */
  defaultSortDirection?: 'asc' | 'desc'
}

export function Table<T>({
  columns,
  data,
  onRowClick,
  getRowKey,
  rowClassName,
  className,
  rowClickTitle,
  cellClassName,
  rowCellClassName,
  defaultSortColumn,
  defaultSortDirection = 'desc',
}: TableProps<T>) {
  const [sortColumn, setSortColumn] = useState<string | null>(
    defaultSortColumn || null
  )
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>(
    defaultSortDirection
  )

  // Handle column header clicks for sorting
  const handleSort = (column: Column<T>) => {
    if (!column.sortable) return

    if (sortColumn === column.key) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')
    } else {
      setSortColumn(column.key)
      // Default to desc for most columns, can be customized
      setSortDirection('desc')
    }
  }

  // Sort the data
  const sortedData = useMemo(() => {
    if (!sortColumn) return data

    const column = columns.find((col) => col.key === sortColumn)
    if (!column) return data

    const sorted = [...data].sort((a, b) => {
      // Use custom sort function if provided
      if (column.sortFn) {
        return column.sortFn(a, b, sortDirection)
      }

      // Otherwise use default sorting with accessor
      if (column.accessor) {
        const aValue = column.accessor(a)
        const bValue = column.accessor(b)

        // Handle numeric values
        if (typeof aValue === 'number' && typeof bValue === 'number') {
          return sortDirection === 'asc' ? aValue - bValue : bValue - aValue
        }

        // Handle string values
        if (typeof aValue === 'string' && typeof bValue === 'string') {
          return sortDirection === 'asc'
            ? aValue.localeCompare(bValue)
            : bValue.localeCompare(aValue)
        }

        // Handle BigInt values
        if (typeof aValue === 'bigint' && typeof bValue === 'bigint') {
          const diff = aValue - bValue
          return sortDirection === 'asc'
            ? Number(diff)
            : Number(bValue - aValue)
        }
      }

      return 0
    })

    return sorted
  }, [data, sortColumn, sortDirection, columns])

  // Helper function to render sort indicator
  const getSortIndicator = (column: Column<T>) => {
    if (!column.sortable) return null

    if (sortColumn !== column.key) {
      return <span className="ml-1 text-text-subtle">↕</span>
    }
    return sortDirection === 'asc' ? (
      <span className="ml-1 text-text">↑</span>
    ) : (
      <span className="ml-1 text-text">↓</span>
    )
  }

  // Helper to get cell className
  const getCellClassName = (column: Column<T>, row: T) => {
    if (typeof column.cellClassName === 'function') {
      return column.cellClassName(row)
    }
    return column.cellClassName
  }

  // Helper to get row className
  const getRowClassName = (row: T) => {
    if (typeof rowClassName === 'function') {
      return rowClassName(row)
    }
    return rowClassName
  }

  // Base cell classes for consistent styling
  // Rows are ruled, not filled. The old treatment gave every row its own
  // rounded grey slab, which turned a dense list into a stack of buttons and
  // made the column grid impossible to read down.
  const baseCellClasses = cn(
    'border-b border-border',
    onRowClick && 'cursor-pointer transition-colors',
    cellClassName
  )

  return (
    <div className={cn('w-full min-w-0 grow overflow-x-auto', className)}>
      <table className="h-full w-full border-collapse">
        <thead>
          <tr>
            {columns.map((column) => {
              return (
                <th
                  key={column.key}
                  className={cn(
                    'select-none border-b border-hairline-strong px-3 py-2 text-left text-xs font-normal uppercase tracking-wider text-text-subtle transition-colors',
                    column.sortable && 'cursor-pointer hover:text-text',
                    column.headerClassName
                  )}
                  onClick={() => handleSort(column)}
                >
                  {/* inline-flex, not flex: a block-level flex container fills
                   * the cell and ignores the th's text-align, so a column
                   * declaring `text-right` in headerClassName would keep its
                   * header stuck on the left while its values moved right. */}
                  <span className="inline-flex items-center gap-1 align-middle">
                    <span>{column.header}</span>
                    {column.tooltip && <InfoTooltip title={column.tooltip} />}
                    {getSortIndicator(column)}
                  </span>
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {sortedData.map((row) => {
            return (
              <tr
                key={getRowKey(row)}
                className={cn(
                  'group/row whitespace-nowrap transition-colors',
                  onRowClick && 'hover:bg-surface-2',
                  getRowClassName(row)
                )}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                title={onRowClick ? rowClickTitle : undefined}
              >
                {columns.map((column) => {
                  const cellClasses = cn(
                    'px-3 py-3',
                    baseCellClasses,
                    rowCellClassName?.(row),
                    getCellClassName(column, row)
                  )

                  return (
                    <td key={column.key} className={cellClasses}>
                      {column.render
                        ? column.render(row)
                        : column.accessor
                          ? String(column.accessor(row))
                          : null}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
