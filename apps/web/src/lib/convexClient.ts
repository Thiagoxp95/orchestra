import { ConvexReactClient } from 'convex/react'

export const CONVEX_URL = process.env.NEXT_PUBLIC_CONVEX_URL as string

let client: ConvexReactClient | null = null

export function getConvexClient(): ConvexReactClient {
  if (!client) client = new ConvexReactClient(CONVEX_URL)
  return client
}
