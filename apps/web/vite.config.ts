import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = 'http://localhost:8787';
const proxied = ['/api', '/status', '/admin', '/webhooks', '/dev'];

export default defineConfig({
  plugins: [react()],
  envDir: '../..',
  server: {
    port: 5173,
    host: true,
    proxy: {
      ...Object.fromEntries(proxied.map((p) => [p, { target, changeOrigin: true }])),
      '/socket.io': { target, ws: true, changeOrigin: true },
    },
  },
  worker: { format: 'es' },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 4000 },
});
