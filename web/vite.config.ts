import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The browser talks only to our own origin. In dev, /api is proxied to the
// Express server (default :3000) so JustTCG/PSA keys never reach the client.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.API_TARGET ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
