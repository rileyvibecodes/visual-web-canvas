import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const shared = {
  bundle: true,
  sourcemap: true,
  minify: false,
  logLevel: 'info',
};

const builds = [
  {
    ...shared,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode', 'react-rewrite-cli'],
  },
  {
    ...shared,
    entryPoints: ['src/runtime.ts'],
    outfile: 'dist/runtime.js',
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
  },
  {
    ...shared,
    entryPoints: ['src/liveRuntime.ts'],
    outfile: 'dist/live-runtime.js',
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
  },
];

if (watch) {
  const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
  await Promise.all(contexts.map((context) => context.watch()));
  console.log('Watching Visual Web Canvas sources...');
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
