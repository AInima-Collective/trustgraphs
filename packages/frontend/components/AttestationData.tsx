'use client'

import { AttestationData } from '@/lib/attestation'
import { SchemaManager } from '@/lib/schemas'
import { cn } from '@/lib/utils'

interface AttestationDataDisplayProps {
  attestation: AttestationData
}

export function AttestationDataDisplay({
  attestation,
}: AttestationDataDisplayProps) {
  const schema = SchemaManager.maybeSchemaForUid(attestation.schema)

  if (!schema) {
    return (
      <div className="space-y-2">
        <div className="text-muted-foreground text-sm font-medium">Data</div>
        <div className="text-foreground text-xs font-mono bg-muted/50 p-3 rounded-md">
          {JSON.stringify(attestation.decodedData, null, 2)}
        </div>
      </div>
    )
  }

  return (
    <>
      {schema.fields.map((field) => {
        const value = attestation.decodedData[field.name]
        return (
          <div key={field.name}>
            <div className="text-muted-foreground text-sm font-medium mb-1">
              {formatFieldName(field.name)}
            </div>
            <div
              className={cn(
                'text-foreground text-xs font-mono break-all',
                (value === undefined || value === null || value === '') &&
                  'opacity-40'
              )}
            >
              {formatFieldValue(value, field.type)}
            </div>
          </div>
        )
      })}
    </>
  )

  // return (
  //   <div className="space-y-3">
  //     <div className="text-muted-foreground text-xs font-medium">
  //       Attestation Data
  //     </div>
  //     <div className="space-y-2">
  //       {schema.fields.map((field) => {
  //         const value = attestation.decodedData[field.name]
  //         return (
  //           <div
  //             key={field.name}
  //             className="flex items-start gap-3 text-sm bg-muted/30 p-3 rounded-md"
  //           >
  //             <div className="flex-shrink-0 w-24">
  //               <div className="text-muted-foreground text-xs font-medium">
  //                 {field.name}
  //               </div>
  //               {/* <div className="text-muted-foreground text-xs opacity-60">
  //                 {field.type}
  //               </div> */}
  //             </div>
  //             <div className="flex-1 min-w-0">
  //               <div className="text-foreground text-xs font-mono break-all">
  //                 {formatFieldValue(value, field.type)}
  //               </div>
  //             </div>
  //           </div>
  //         )
  //       })}
  //     </div>
  //   </div>
  // )
}

// Convert snake_case to Title Case
const formatFieldName = (name: string): string => {
  return name.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
}

function formatFieldValue(
  value: string | boolean | undefined,
  type: string
): string {
  if (value === undefined || value === null) {
    return '(empty)'
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }

  // Format based on type
  if (type === 'uint256' && typeof value === 'string') {
    // Try to make large numbers more readable
    if (value.length > 18) {
      // Might be wei
      const num = BigInt(value)
      const eth = Number(num) / 1e18
      if (eth < 1e6) {
        return `${value} (${eth.toFixed(6)} ETH)`
      }
    }
    // Add thousand separators for readability
    return value.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  }

  if (type === 'address' && typeof value === 'string') {
    return value
  }

  if (type.startsWith('bytes') && typeof value === 'string') {
    // Format bytes nicely
    if (value.length > 66) {
      // Long bytes, truncate
      return `${value.slice(0, 34)}...${value.slice(-6)}`
    }
    return value
  }

  return String(value) || '(empty)'
}
