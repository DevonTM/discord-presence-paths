import { defineConfig } from 'vite';

function setSqliteContentType(req, res, next) {
  const path = (req.url || '').split('?')[0];
  if (path === '/detectable.db') {
    res.setHeader('Content-Type', 'application/vnd.sqlite3');
  }
  next();
}

const sqliteContentTypePlugin = {
  name: 'sqlite-content-type',
  configureServer(server) {
    server.middlewares.use(setSqliteContentType);
  },
  configurePreviewServer(server) {
    server.middlewares.use(setSqliteContentType);
  },
};

export default defineConfig({
  plugins: [sqliteContentTypePlugin],
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
