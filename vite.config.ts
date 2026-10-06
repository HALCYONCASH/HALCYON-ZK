import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5180, proxy: { '/api': 'http://127.0.0.1:4180', '/m': 'http://127.0.0.1:4180', '/i': 'http://127.0.0.1:4180' } },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 1200 },
});
