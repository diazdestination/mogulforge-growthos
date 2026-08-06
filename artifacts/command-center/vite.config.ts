import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';
import { CLIENT } from './src/lib/client.config';

/**
 * Injects client branding into index.html at build/serve time so that
 * index.html and index.css never need hand-editing for a new client.
 *
 * Replaces every %CLIENT_APP_NAME% placeholder and prepends a <style>
 * block that sets the --primary CSS variable from client.config.ts.
 */
function clientBrandingPlugin(): Plugin {
  return {
    name: 'client-branding',
    transformIndexHtml(html: string) {
      const branded = html.replaceAll('%CLIENT_APP_NAME%', CLIENT.appName);
      // Doubled selectors (:root:root / .dark.dark) raise specificity above the
      // plain :root/.dark rules baked into index.css, so the config-driven brand
      // color wins regardless of stylesheet load order (in dev Vite injects
      // index.css after <head>, which would otherwise beat a plain :root here).
      const styleBlock = `
  <style>
    /* Injected from src/lib/client.config.ts — do not edit here */
    :root:root { --primary: ${CLIENT.primaryHsl}; }
    .dark.dark { --primary: ${CLIENT.primaryHslDark}; }
  </style>`;
      return branded.replace('</head>', `${styleBlock}\n  </head>`);
    },
  };
}

const rawPort = process.env.PORT ?? '5173';
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH?.trim() || '/';

export default defineConfig({
  base: basePath,
  plugins: [
    clientBrandingPlugin(),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    // Local dev: the SPA calls same-origin /api/* — proxy those to the API
    // server. Production serves both from the API container on one origin.
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.API_PORT ?? 3001}`,
        changeOrigin: true,
      },
    },
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
});
