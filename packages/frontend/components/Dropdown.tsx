'use client'

import { Dispatch, ReactNode, SetStateAction, useRef } from 'react'

import { cn } from '@/lib/utils'

import { Button, ButtonProps } from './Button'
import { Popup } from './Popup'

export interface DropdownOption<T extends string = string> {
  value: T
  label: string
}

export interface DropdownProps<T extends string = string> {
  /** List of options to display in the dropdown */
  options: DropdownOption<T>[]
  /** Currently selected option value */
  selected: T
  /** Callback when an option is selected */
  onSelect: (value: T) => void
  /** Optional icon to show before the label on the trigger button */
  icon?: ReactNode
  /** Size of the trigger button */
  triggerSize?: ButtonProps['size']
  /** Additional class name for the trigger button */
  triggerClassName?: string
  /** Additional class name for the option buttons */
  optionClassName?: string
  /** Variant of the trigger button when closed */
  triggerVariant?: ButtonProps['variant']
  /** Variant of the trigger button when open */
  triggerVariantOpen?: ButtonProps['variant']
}

export const Dropdown = <T extends string = string>({
  options,
  selected,
  onSelect,
  icon,
  triggerSize = 'default',
  triggerClassName = '',
  optionClassName = '',
  triggerVariant = 'secondary',
  triggerVariantOpen = 'outline',
}: DropdownProps<T>) => {
  const setFilterOpenRef = useRef<Dispatch<SetStateAction<boolean>> | null>(
    null
  )

  // Find the selected option's label
  const selectedOption = options.find((opt) => opt.value === selected)
  const selectedLabel = selectedOption?.label || options[0]?.label || ''

  const handleSelect = (value: T) => {
    onSelect(value)
    setFilterOpenRef.current?.(false)
  }

  return (
    <Popup
      position="left"
      popupClassName="!p-0"
      popupPadding={0}
      setOpenRef={setFilterOpenRef}
      trigger={{
        type: 'custom',
        Renderer: ({ onClick, open }) => (
          <Button
            variant={open ? triggerVariantOpen : triggerVariant}
            onClick={onClick}
            size={triggerSize}
            className={cn('gap-3', triggerClassName)}
          >
            {icon}
            <span>{selectedLabel}</span>
          </Button>
        ),
      }}
    >
      {options.map((option, index) => {
        const isFirst = index === 0
        const isLast = index === options.length - 1

        return (
          <Button
            key={option.value}
            variant="ghost"
            className={cn(
              '!rounded-none !px-3 justify-start',
              isFirst ? '!pt-2.5 !pb-2' : isLast ? '!pt-2 !pb-2.5' : '!py-2',
              optionClassName
            )}
            size={null}
            onClick={() => handleSelect(option.value)}
          >
            {option.label}
          </Button>
        )
      })}
    </Popup>
  )
}
