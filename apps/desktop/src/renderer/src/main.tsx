import React from 'react'
import ReactDOM from 'react-dom/client'
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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
