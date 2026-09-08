import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * Browser bundle build.
 *
 * Build only. There is no dev server configuration here and none is used: the
 * console is a static artifact served by whatever already fronts the hosted API,
 * which is also what lets `connect-src 'self'` hold.
 *
 * `dist-web` rather than `dist`, because `dist` belongs to `tsc --build` and is
 * what `verify:scaffold` inspects. Two build systems writing one directory is a
 * race waiting to be debugged at the worst possible moment.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  // Relative asset URLs, so the console works under any path prefix a reverse
  // proxy chooses without a rebuild.
  base: './',
  build: {
    outDir: 'dist-web',
    emptyOutDir: true,
    target: 'es2023',
    // Deterministic names: the security review reads a diff of the bundle, and
    // a content hash that changes on every build makes that diff unreadable.
    rollupOptions: {
      output: {
        entryFileNames: 'assets/console.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
    // The bundle is auditable output. A source map would ship the full source of
    // a security tool to every browser that loads it (docs/adr/0009).
    sourcemap: false,
    // Vite 8 bundles with rolldown and minifies with oxc; the JSX runtime comes
    // from `jsx: "react-jsx"` in tsconfig, so no framework plugin is needed and
    // none is installed. Fast Refresh is the only thing a plugin would add, and
    // this build never runs a dev server.
    minify: true,
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
});
