'use client'

import {
  ArcElement,
  Chart as ChartJS,
  ChartOptions,
  Legend,
  Tooltip,
} from 'chart.js'
import clsx from 'clsx'
import { ChevronLeft } from 'lucide-react'
import type React from 'react'
import { useState } from 'react'
import { Pie } from 'react-chartjs-2'

ChartJS.register(ArcElement, Tooltip, Legend)

export type PieLevel = {
  title: string
  values: {
    title: string
    value: number
    color: string
    subPie?: Omit<PieLevel, 'title'> & { title?: string }
  }[]
  /**
   * Set when entering a sub-pie. Used to reset to parent pie when leaving.
   */
  parent?: PieLevel
}

export type InteractivePieProps = {
  /**
   * Points held by the current wallet.
   */
  yourPoints: number
  /**
   * Points held by all others.
   */
  otherPoints: number
}

export const InteractivePie = ({
  yourPoints,
  otherPoints,
}: InteractivePieProps) => {
  const rootPieLevel: PieLevel = {
    title: 'All Phases',
    values: [
      {
        title: 'Phase 1',
        value: 1,
        color: 'rgb(36, 36, 36)',
        subPie: {
          values: [
            { title: 'Your points', value: yourPoints, color: '#dd70d4' },
            {
              title: "Others' points",
              value: otherPoints,
              color: 'rgb(24, 24, 24)',
            },
          ],
        },
      },
      {
        title: 'Remaining phases',
        value: 99,
        color: 'rgb(24, 24, 24)',
      },
    ],
  }

  const getSelectedPieLevel = (
    currentLevel: PieLevel,
    index: number
  ): PieLevel => {
    const pieLevel = currentLevel.values[index].subPie as PieLevel | undefined
    if (!pieLevel) {
      return currentLevel
    }

    pieLevel.title = currentLevel.values[index].title
    pieLevel.parent = currentLevel

    return pieLevel
  }

  const [activePieLevel, setActivePieLevel] = useState(() =>
    getSelectedPieLevel(rootPieLevel, 0)
  )

  const pieChartData = {
    labels: activePieLevel.values.map((entry) => entry.title),
    datasets: [
      {
        data: activePieLevel.values.map((entry) => entry.value),
        backgroundColor: activePieLevel.values.map((entry) => entry.color),
        borderWidth: 0,
      },
    ],
  }

  const pieChartOptions: ChartOptions<'pie'> = {
    // cutout: 32,
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: false,
      },
      title: {
        display: false,
      },
      tooltip: {
        callbacks: {
          label: (context) => {
            const value = context.parsed
            return activePieLevel === rootPieLevel
              ? `${value.toLocaleString()}%`
              : `${value.toLocaleString()} points`
          },
        },
      },
    },
    animation: {
      animateRotate: true,
    },
    onClick: (_, elements) => {
      if (elements.length > 0) {
        setActivePieLevel(
          getSelectedPieLevel(activePieLevel, elements[0].index)
        )
      }
    },
    onHover: (_, elements, chart) => {
      if (elements.length > 0) {
        const hoveredData = activePieLevel.values[elements[0].index]
        chart.canvas.style.cursor = hoveredData.subPie ? 'pointer' : 'default'
      } else {
        chart.canvas.style.cursor = 'default'
      }
    },
  }

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative flex flex-row justify-center items-center">
        {activePieLevel !== rootPieLevel && (
          <button
            onClick={() =>
              setActivePieLevel(activePieLevel.parent || rootPieLevel)
            }
            className={clsx(
              'absolute -left-[1.75rem] text-sm text-text-subtle hover:text-text cursor-pointer'
            )}
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
        )}

        <h1 className="text-base">{activePieLevel.title}</h1>
      </div>

      <div className="flex items-center justify-center gap-4">
        <div className="w-56 h-56">
          <Pie data={pieChartData} options={pieChartOptions} />
        </div>
      </div>
    </div>
  )
}
