import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const backend = `http://127.0.0.1:${process.env.PORT ?? '8787'}`;

export default defineConfig({
  root: 'src/client',
  publicDir: 'public',
  plugins: [react()],
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': { target: backend, changeOrigin: false },
      '/jf': { target: backend, changeOrigin: false },
    },
  },
  preview: { port: 4173 },
});
