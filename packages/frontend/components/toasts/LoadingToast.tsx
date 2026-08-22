import { LoaderCircle } from 'lucide-react'
import { Toast } from 'react-hot-toast'

import { ToastCard } from './ToastCard'

export interface LoadingToastProps {
  toast: Toast
}

export const LoadingToast = (props: LoadingToastProps) => (
  <ToastCard
    preMessage={
      <LoaderCircle
        size={20}
        className="animate-spin text-muted-foreground flex-shrink-0"
      />
    }
    {...props}
  />
)
