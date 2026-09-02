import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const shared = fileURLToPath(new URL('../../packages/shared/src', import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  resolve: { alias: [{ find: '@platform/shared', replacement: shared }] },
  server: { port: 5173, strictPort: true, proxy: { '/api': 'http://localhost:8787' } },
  preview: { port: 6173, strictPort: true, proxy: { '/api': 'http://localhost:8787' } },
  build: { outDir: 'dist', emptyOutDir: true },
});
