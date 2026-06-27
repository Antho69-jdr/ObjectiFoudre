// Build frontend ObjectiFoudre — esbuild.
// Deux entrées : le bundle CSS (design system) et le bundle JS (modules ES).
// Sortie stable dans assets/dist/ : app.css + app.js (+ sourcemaps).
// La gestion du cache PWA reste assurée par le suffixe ?v=APP_VERSION dans index.html/sw.js
// (même discipline que le reste du projet), donc on garde des noms de fichiers stables.
//
// IMPORTANT : ce build tourne EN LOCAL uniquement. Render est runtime:python (pip install)
// et ne dispose pas de node. On committe donc assets/dist/.

import * as esbuild from 'esbuild';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const outdir = resolve(root, 'assets/dist');
mkdirSync(outdir, { recursive: true });

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  absWorkingDir: root,
  entryPoints: [
    { in: 'assets/src/js/main.js', out: 'app' },
    { in: 'assets/src/styles/index.css', out: 'app' },
    { in: 'assets/src/styles/theme.css', out: 'theme' },
  ],
  outdir: 'assets/dist',
  bundle: true,
  format: 'esm',
  target: ['es2020', 'chrome100', 'firefox100', 'safari15', 'edge100'],
  minify: !watch,
  sourcemap: true,
  logLevel: 'info',
  legalComments: 'none',
  loader: {
    '.png': 'file',
    '.svg': 'file',
    '.woff': 'file',
    '.woff2': 'file',
  },
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[build] watch actif — Ctrl-C pour arrêter.');
} else {
  await esbuild.build(options);
  console.log('[build] terminé → assets/dist/app.js + app.css');
}
