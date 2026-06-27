import React from 'react'
import ReactDOM from 'react-dom/client'
import { ConvexProvider, ConvexReactClient } from 'convex/react'
import { App } from './App'
import './index.css'

// Warm the bundled terminal font BEFORE any xterm terminal mounts. xterm measures
// the glyph cell from the live font; if the custom Nerd Font (font-display: block)
// has not decoded yet, it measures the fallback (Menlo) and the terminal opens
// mis-sized — short, with duplicate/ghost lines — until a manual resize. Kicking
// off the decode here means the first terminal open already sees the right metrics.
// The per-terminal controller still heals any face that decodes later.
const TERMINAL_FONT = '"JetBrainsMono Nerd Font Mono"'
for (const spec of ['14px', 'bold 14px', 'italic 14px', 'bold italic 14px']) {
  void document.fonts?.load?.(`${spec} ${TERMINAL_FONT}`).catch(() => {})
}

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
