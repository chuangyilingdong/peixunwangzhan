import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('.', import.meta.url));
const shared = fileURLToPath(new URL('../../packages/shared/src', import.meta.url));
const canvas = fileURLToPath(new URL('../../packages/canvas/src', import.meta.url));
const appBase = process.env.VITE_APP_BASE || '/org/';
// 与 website 一致：本地验证时可以指向临时后端（VITE_DEV_API_TARGET），默认仍是 8787
const apiTarget = process.env.VITE_DEV_API_TARGET || 'http://localhost:8787';
export default defineConfig({ root, base: appBase, plugins: [react()], resolve: { alias: [{ find: '@platform/shared', replacement: shared }, { find: '@platform/canvas', replacement: canvas }] }, server: { port: 5175, strictPort: true, proxy: { '/api': apiTarget } }, preview: { port: 6175, strictPort: true, proxy: { '/api': apiTarget } }, build: {
  outDir: 'dist',
  emptyOutDir: true,
  rollupOptions: {
    output: {
      // 2026-09-17 线上故障：pdf.js 的 worker 源文件是 .mjs，构建产物也是 .mjs；而生产 nginx 的
      // mime.types 里只有 `application/javascript js;`、**没有 mjs** → 回落成
      // application/octet-stream，配合 X-Content-Type-Options: nosniff，浏览器直接拒收这个模块
      // （报 "Failed to fetch dynamically imported module"）。文件是 200 能取到的，
      // 所以只看状态码发现不了 —— 本地 vite preview 也不复现（它自己会配对 MIME）。
      // 强制把 .mjs 产物改名为 .js：不依赖服务器 MIME 配置，换台机器、换个反代都不会再犯。
      assetFileNames: (asset) => {
        const names = asset.names || (asset.name ? [asset.name] : []);
        return names.some((name) => name.endsWith('.mjs'))
          ? 'assets/[name]-[hash].js'
          : 'assets/[name]-[hash][extname]';
      },
    },
  },
} });
