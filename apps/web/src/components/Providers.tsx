'use client'
import { ConvexProvider } from 'convex/react'
import { getConvexClient } from '../lib/convexClient'

export function Providers({ children }: { children: React.ReactNode }) {
  return <ConvexProvider client={getConvexClient()}>{children}</ConvexProvider>
}
