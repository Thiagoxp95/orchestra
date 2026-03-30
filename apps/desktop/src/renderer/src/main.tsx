import React from 'react'
import ReactDOM from 'react-dom/client'
import { ConvexProvider, ConvexReactClient } from 'convex/react'
import { App } from './App'
import './index.css'

const convex = new ConvexReactClient(import.meta.env.RENDERER_VITE_CONVEX_URL)

// React.createElement bypasses tsgo JSX type check for ConvexProvider
// (convex bundles React 19 FC types incompatible with project's React 18)
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {React.createElement(ConvexProvider, { client: convex }, <App />)}
  </React.StrictMode>
)
