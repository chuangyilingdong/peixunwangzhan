import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('.', import.meta.url));
const shared = fileURLToPath(new URL('../../packages/shared/src', import.meta.url));
const canvas = fileURLToPath(new URL('../../packages/canvas/src', import.meta.url));
const deploymentMode = process.env.VITE_DEPLOYMENT_MODE || 'public';
const robotsContent = deploymentMode === 'internal-test' ? 'noindex, nofollow, noarchive' : 'index,follow';
const publicSiteUrl = (process.env.VITE_PUBLIC_SITE_URL || 'http://localhost:5176').replace(/\/$/, '');
const apiTarget = process.env.VITE_DEV_API_TARGET || 'http://localhost:8787';
export default defineConfig({
  root,
  plugins: [
    react(),
    {
      name: 'deployment-robots-meta',
      transformIndexHtml(html) {
        return html
          .replace(/<meta name="robots" content="[^"]*"\/>/, '<meta name="robots" content="' + robotsContent + '"/>')
          .replace(/(<link rel="canonical" href=")[^"]*("\/\>)/, '$1' + publicSiteUrl + '/$2')
          .replace(/(<meta property="og:url" content=")[^"]*("\/\>)/, '$1' + publicSiteUrl + '/$2');
      }
    }
  ],
  resolve: { alias: [{ find: '@platform/shared', replacement: shared }, { find: '@platform/canvas', replacement: canvas }] },
  server: { port: 5176, strictPort: true, proxy: { '/api': apiTarget } },
  preview: { port: 6176, strictPort: true, proxy: { '/api': apiTarget } },
  build: { outDir: 'dist', emptyOutDir: true }
});
