import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const server = `http://127.0.0.1:${process.env.T3C_PORT ?? 4773}`

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // During development the t3-command server runs separately; forward API and relay traffic to it.
    proxy: {
      '/api': server,
      '/env': { target: server, ws: true },
    },
  },
})
