'use client'

import { Braces, ChevronDown, Table } from 'lucide-react'

import {
  ScoreboardExportEntry,
  ScoreboardExportMetadata,
  serializeScoreboardCSV,
  serializeScoreboardJSON,
} from '@/lib/scoreboard-export'

import { Button, ButtonProps } from './Button'
import { Popup } from './Popup'

interface ExportButtonProps {
  data: ScoreboardExportEntry[]
  metadata: ScoreboardExportMetadata
  filename?: string
  className?: string
  size?: ButtonProps['size']
}

export const ExportButton = ({
  data,
  metadata,
  filename = 'trust-graph-network',
  className,
  size = 'default',
}: ExportButtonProps) => {
  const downloadFile = (
    content: string,
    fileName: string,
    contentType: string
  ) => {
    const blob = new Blob([content], { type: contentType })
    const url = window.URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    window.URL.revokeObjectURL(url)
  }

  const exportAsCSV = () => {
    if (!data || data.length === 0) {
      console.warn('No data available for export')
      return
    }

    const csvContent = serializeScoreboardCSV({ data, metadata })
    downloadFile(
      csvContent,
      `${filename}${metadata.mode === 'simulation' ? '_SIMULATION' : ''}.csv`,
      'text/csv'
    )
  }

  const exportAsJSON = () => {
    if (!data || data.length === 0) {
      console.warn('No data available for export')
      return
    }

    const jsonContent = serializeScoreboardJSON({ data, metadata })
    downloadFile(
      jsonContent,
      `${filename}${metadata.mode === 'simulation' ? '_SIMULATION' : ''}.json`,
      'application/json'
    )
  }

  if (!data || data.length === 0) {
    return null
  }

  return (
    <Popup
      position="same"
      popupClassName="!p-0"
      popupPadding={0}
      trigger={{
        type: 'custom',
        Renderer: ({ onClick, open }) => (
          <Button
            variant={open ? 'outline' : 'secondary'}
            onClick={onClick}
            size={size}
            className={className}
          >
            <span>
              {metadata.mode === 'simulation' ? 'EXPORT SIMULATION' : 'EXPORT'}
            </span>
            <ChevronDown className="w-4 h-4" />
          </Button>
        ),
      }}
    >
      <Button
        variant="ghost"
        className="!rounded-none !px-3 !pt-2.5 !pb-2 justify-start"
        size={null}
        onClick={exportAsCSV}
      >
        <Table className="!w-4 !h-4" />
        {metadata.mode === 'simulation' ? 'SIMULATED CSV' : 'CSV'}
      </Button>
      <Button
        variant="ghost"
        className="!rounded-none !px-3 !pt-2 !pb-2.5 justify-start"
        size={null}
        onClick={exportAsJSON}
      >
        <Braces className="!w-4 !h-4" />
        {metadata.mode === 'simulation' ? 'SIMULATED JSON' : 'JSON'}
      </Button>
    </Popup>
  )
}
