import { build, context } from 'esbuild'
import { fileURLToPath } from 'node:url'

const watchMode = process.argv.includes('--watch')

const here = (p) => fileURLToPath(new URL(p, import.meta.url))

const options = {
  entryPoints: [here('./src/main.tsx')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['node20'],
  outfile: here('./bin/halis.js'),
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __halisCreateRequire } from 'node:module'",
      'const require = __halisCreateRequire(import.meta.url)',
    ].join('\n'),
  },
  jsx: 'automatic',
  sourcemap: true,
  logLevel: 'info',
  alias: {
    '@halis/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
    'react-devtools-core': fileURLToPath(new URL('./src/devtools-stub.ts', import.meta.url)),
  },
}

if (watchMode) {
  const ctx = await context(options)
  await ctx.watch()
  console.log('watching for changes...')
} else {
  await build(options)
  console.log('build done -> bin/halis.js')
}
