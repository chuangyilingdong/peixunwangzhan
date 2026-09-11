import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const apiTarget = process.env.VITE_DEV_API_TARGET || 'http://localhost:8787';
const shared = fileURLToPath(new URL('../../packages/shared/src', import.meta.url));
const canvas = fileURLToPath(new URL('../../packages/canvas/src', import.meta.url));
const appBase = process.env.VITE_APP_BASE || '/admin/';

export default defineConfig({
  root,
  base: appBase,
  plugins: [react()],
  resolve: { alias: [{ find: '@platform/shared', replacement: shared }, { find: '@platform/canvas', replacement: canvas }] },
  server: { port: 5173, strictPort: true, proxy: { '/api': apiTarget } },
  preview: { port: 6173, strictPort: true, proxy: { '/api': apiTarget } },
  build: { outDir: 'dist', emptyOutDir: true },
});
