import clsx from 'clsx'
import { X } from 'lucide-react'
import { ReactNode, cloneElement } from 'react'
import { Toast, ToastBar, toast as hotToast } from 'react-hot-toast'

import { Card } from '../Card'

export interface ToastCardProps {
  toast: Toast
  containerClassName?: string
  preMessage?: ReactNode
}

export const ToastCard = ({
  toast,
  containerClassName,
  preMessage,
}: ToastCardProps) => (
  <ToastBar toast={toast}>
    {({ message }) => (
      <Card
        type="popover"
        size="md"
        className={clsx(
          'relative flex min-w-0 flex-row items-start gap-3 text-sm',
          toast.type !== 'loading' && 'pr-10',
          containerClassName
        )}
      >
        {preMessage}

        <div
          className={clsx(
            'min-w-0 grow break-words',
            toast.type === 'error'
              ? 'text-destructive-foreground'
              : 'text-popover-foreground'
          )}
        >
          {!message || typeof message === 'string' ? (
            <p className="m-0">{message}</p>
          ) : (
            cloneElement(message, {
              className: '!block !m-0 break-words',
            } as any)
          )}
        </div>

        {toast.type !== 'loading' && (
          <button
            onClick={() => hotToast.dismiss(toast.id)}
            className={clsx(
              'absolute top-3 right-3 transition-colors p-1 rounded-sm',
              toast.type === 'error'
                ? 'text-destructive-foreground/70 hover:text-destructive-foreground hover:bg-destructive-foreground/10'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted'
            )}
            aria-label="Dismiss"
          >
            <X size={16} />
          </button>
        )}
      </Card>
    )}
  </ToastBar>
)
