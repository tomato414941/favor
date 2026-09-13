import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'client',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 3211,
    strictPort: true,
    proxy: { '/api/': 'http://127.0.0.1:3210' },
  },
  build: { outDir: '../dist/client', emptyOutDir: true },
});
