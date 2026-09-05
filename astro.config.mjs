import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import netlify from '@astrojs/netlify';
import { existsSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// https://astro.build/config
export default defineConfig({
  output: 'static',
  adapter: netlify({ devFeatures: { edgeFunctions: false } }),
  integrations: [
    tailwind()
  ],
  vite: {
    build: {
      // lightningcss (Vite 8 default) rejects some Tailwind CSS; esbuild handles it fine
      cssMinify: 'esbuild',
    },
    plugins: [
      // serve pre-built /_astro/ assets in dev (Netlify middleware doesn't forward them to Vite)
      {
        name: 'serve-dist-astro',
        configureServer(server) {
          const distAstro = join(fileURLToPath(new URL('.', import.meta.url)), 'dist', '_astro');
          server.middlewares.use('/_astro', (req, res, next) => {
            const file = join(distAstro, req.url.split('?')[0]);
            if (existsSync(file)) {
              const ext = file.split('.').pop();
              const mime = ext === 'css' ? 'text/css' : 'application/javascript';
              res.setHeader('Content-Type', mime);
              createReadStream(file).pipe(res);
            } else {
              next();
            }
          });
        }
      }
    ],
  },
});
