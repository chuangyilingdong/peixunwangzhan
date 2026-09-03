import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('.',import.meta.url));
const deploymentMode = process.env.VITE_DEPLOYMENT_MODE || 'public';
const robotsContent = deploymentMode === 'internal-test' ? 'noindex, nofollow, noarchive' : 'index,follow';
const publicSiteUrl = (process.env.VITE_PUBLIC_SITE_URL || 'http://localhost:5176').replace(/\/$/, '');
export default defineConfig({
  root,
  plugins:[react(), { name:'deployment-robots-meta', transformIndexHtml(html) { return html
      .replace(/<meta name="robots" content="[^"]*"\/>/, `<meta name="robots" content="${robotsContent}"/>`)
      .replace(/(<link rel="canonical" href=")[^"]*("\/>)/, `$1${publicSiteUrl}/$2`)
      .replace(/(<meta property="og:url" content=")[^"]*("\/>)/, `$1${publicSiteUrl}/$2`); } }],
  server:{port:5176,strictPort:true},
  preview:{port:6176,strictPort:true},
  build:{outDir:'dist',emptyOutDir:true}
});
