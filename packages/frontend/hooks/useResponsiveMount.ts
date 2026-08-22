import { useEffect, useState } from 'react'

const tailwindBreakpoints = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  '2xl': 1536,
}

export const useResponsiveMount = (
  breakpoint: keyof typeof tailwindBreakpoints,
  above = true
) => {
  const [shouldMount, setShouldMount] = useState(false)

  useEffect(() => {
    const checkBreakpoint = () => {
      const width = window.innerWidth
      const breakpointValue = tailwindBreakpoints[breakpoint]
      setShouldMount(above ? width >= breakpointValue : width < breakpointValue)
    }

    // Check on mount
    checkBreakpoint()

    // Run every 5 seconds as a fallback.
    const interval = setInterval(checkBreakpoint, 5000)

    // Add resize listener.
    window.addEventListener('resize', checkBreakpoint)

    return () => {
      window.removeEventListener('resize', checkBreakpoint)
      clearInterval(interval)
    }
  }, [breakpoint, above])

  return shouldMount
}
