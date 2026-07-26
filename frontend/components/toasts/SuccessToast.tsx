import { CheckCircle2 } from 'lucide-react'
import { Toast } from 'react-hot-toast'

import { ToastCard } from './ToastCard'

export interface SuccessToastProps {
  toast: Toast
}

export const SuccessToast = (props: SuccessToastProps) => (
  <ToastCard
    preMessage={
      <CheckCircle2
        size={20}
        className="text-success dark:text-success flex-shrink-0"
      />
    }
    {...props}
  />
)
