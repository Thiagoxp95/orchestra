import { readFileSync } from 'fs'
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Baked into the renderer at build time. The release workflow stamps the tag
// version into package.json before `electron-vite build`, so this matches the
// packaged app.getVersion().
const APP_VERSION = JSON.parse(readFileSync(resolve('package.json'), 'utf-8')).version

// Prevent parent environment (e.g. Claude Code terminal) from forcing
// Electron to run as plain Node.js, which breaks require('electron').
delete process.env.ELECTRON_RUN_AS_NODE

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['electron-store', 'croner'] })],
    build: {
      rollupOptions: {
        external: ['bufferutil', 'utf-8-validate'],
        input: {
          index: resolve('src/main/index.ts'),
          daemon: resolve('src/daemon/daemon.ts'),
          'pty-subprocess': resolve('src/daemon/pty-subprocess.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      },
      // Kept from when this app shared source with apps/web (whose node_modules
      // hold React 19): a second React copy reaching the renderer breaks hooks,
      // and the guard costs nothing.
      dedupe: ['react', 'react-dom']
    },
    plugins: [tailwindcss(), react()],
    define: {
      __APP_VERSION__: JSON.stringify(APP_VERSION)
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          popup: resolve('src/renderer/popup.html'),
        }
      }
    }
  }
})
