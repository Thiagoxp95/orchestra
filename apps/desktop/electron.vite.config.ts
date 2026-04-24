import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Prevent parent environment (e.g. Claude Code terminal) from forcing
// Electron to run as plain Node.js, which breaks require('electron').
delete process.env.ELECTRON_RUN_AS_NODE

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['electron-store', 'croner', 'convex'] })],
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
      }
    },
    plugins: [tailwindcss(), react()],
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
