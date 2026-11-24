import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
  build: {
    chunkSizeWarningLimit: 200,
    // Split React + ReactDOM out of the initial index chunk. React is
    // a single-purpose package with no barrel tree-shaking loss, so
    // this keeps total initial JS the same while the index chunk
    // drops under the 200 kB advisory. MUI/Emotion/router/query stay
    // in the default chunking: grouping them by package path pulls
    // in whole barrels and made total initial JS ~2.3x larger in
    // testing (251.51 kB -> ~575 kB), so they are deliberately NOT
    // split out. App code and lazy pages are untouched.
    //
    // Measured initial JS (scripts/measure-initial-js.mjs: the JS
    // files directly referenced by dist/index.html — entry script +
    // modulepreload links; lazy chunks and network overhead are not
    // counted). Reviewed Phase 7 tree: 464,167 bytes, 149,373 bytes
    // gzipped (level 9). Per chunk: vendor-react 218,754 (react-dom
    // client 529,536 rendered — the bulk of the initial load);
    // i18n 97,060 (createThemeWithVars 23,546 + i18n.ts 16,417
    // rendered; the two language dictionaries together are ~17.7 kB
    // source, so splitting them would save only ~4-8 kB and was not
    // taken); client 69,843 (react-query core + shared MUI components
    // the root genuinely needs; client.ts itself is only ~9 kB
    // rendered); index 38,587; router chunk 39,324 (react-router
    // 95,471 rendered); rolldown-runtime 599.
    //
    // Phase 8 profiling found no duplicated module across chunks and
    // verified by reading the installed @mui/material package that
    // createThemeNoVars is NOT exported (the deep subpath is blocked
    // by the package exports map), so a no-vars createTheme import
    // is not an available reduction. No further split was kept: none
    // measured a total reduction. Nothing here claims a lower total
    // is or is not achievable — only what was measured and tried.
    rolldownOptions: {
      output: {
        manualChunks: (id: string) => {
          if (
            id.includes('/node_modules/react-dom/') ||
            id.includes('/node_modules/react/') ||
            id.includes('/node_modules/scheduler/')
          ) {
            return 'vendor-react';
          }
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    exclude: ['e2e/**', 'node_modules/**'],
  },
});
