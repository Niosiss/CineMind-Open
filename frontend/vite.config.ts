import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Browser-only static deployment: assets are resolved relative to the built
// index.html. There is no backend proxy; all data lives in localStorage and
// ranking/training runs in the generated wasm-bindgen module.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
})
