import React from 'react'
import ReactDOM from 'react-dom/client'
import { ConvexProvider, ConvexReactClient } from 'convex/react'
import { App } from './App'
import './index.css'

const convex = new ConvexReactClient(import.meta.env.RENDERER_VITE_CONVEX_URL)

// convex@1.34 bundles React 19 FC types. The desktop renderer is on React 18
// (and not ready to migrate), so the FC<P> shape that ConvexProvider exports
// from React 19's @types/react is structurally incompatible with what React
// 18's createElement expects, even though both shapes are identical at
// runtime. Cast to any to bypass the cross-version type check; runtime
// behavior is unaffected.
const ConvexProviderAny = ConvexProvider as unknown as React.FC<{
  client: ConvexReactClient
  children?: React.ReactNode
}>

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConvexProviderAny client={convex}>
      <App />
    </ConvexProviderAny>
  </React.StrictMode>
)
