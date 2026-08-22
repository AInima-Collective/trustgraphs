import { Toaster as HotToaster } from 'react-hot-toast'

import { ErrorToast } from './ErrorToast'
import { LoadingToast } from './LoadingToast'
import { SuccessToast } from './SuccessToast'

export const Toaster = () => (
  <HotToaster
    position="bottom-right"
    reverseOrder
    gutter={12}
    containerStyle={{
      bottom: 20,
      right: 20,
    }}
    toastOptions={{
      duration: 6000,
      // Show for entire duration of promise
      loading: {
        duration: Infinity,
      },
      // Remove default styles to let our Card component handle styling
      style: {
        background: 'none',
        boxShadow: 'none',
        padding: 0,
        margin: 0,
      },
    }}
  >
    {(t) =>
      t.type === 'error' ? (
        <ErrorToast toast={t} />
      ) : t.type === 'loading' ? (
        <LoadingToast toast={t} />
      ) : (
        <SuccessToast toast={t} />
      )
    }
  </HotToaster>
)
