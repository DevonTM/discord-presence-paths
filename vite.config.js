import { defineConfig } from 'vite';

const sqliteContentTypePlugin = () => ({
  name: 'sqlite-content-type',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url?.split('?')[0] === '/detectable.db') {
        res.setHeader('Content-Type', 'application/vnd.sqlite3');
      }
      next();
    });
  },
  configurePreviewServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url?.split('?')[0] === '/detectable.db') {
        res.setHeader('Content-Type', 'application/vnd.sqlite3');
      }
      next();
    });
  },
});

export default defineConfig({
  plugins: [sqliteContentTypePlugin()],
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
});
