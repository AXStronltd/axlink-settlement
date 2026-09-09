import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        // The ops dashboard is an internal tool, but it still runs in a
        // browser — so the service credential is attached here, by the dev
        // server, rather than shipped in client code where anyone with the
        // page could read it.
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            const key = process.env.SETTLEMENT_API_KEY ?? 'local_dev_settlement_key';
            if (!proxyReq.getHeader('authorization')) {
              proxyReq.setHeader('authorization', `Bearer ${key}`);
            }
          });
        },
      },
    },
  },
})
