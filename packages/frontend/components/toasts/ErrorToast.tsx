import { AlertCircle } from 'lucide-react'
import { Toast } from 'react-hot-toast'

import { ToastCard } from './ToastCard'

export interface ErrorToastProps {
  toast: Toast
}

export const ErrorToast = (props: ErrorToastProps) => (
  <ToastCard
    containerClassName="!bg-destructive !border-destructive"
    preMessage={
      <AlertCircle
        size={20}
        className="text-destructive-foreground flex-shrink-0"
      />
    }
    {...props}
  />
)
