import { build, context } from 'esbuild'
import { cpSync, mkdirSync } from 'node:fs'

const watch = process.argv.includes('--watch')

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  target: 'es2023'
}

const targets = [
  {
    name: 'main',
    options: {
      ...common,
      entryPoints: ['electron/main/index.ts'],
      platform: 'node',
      format: 'cjs',
      target: ['node20'],
      external: ['electron'],
      outfile: 'dist/main/index.js'
    }
  },
  {
    name: 'preload',
    options: {
      ...common,
      entryPoints: ['electron/preload/index.ts'],
      platform: 'node',
      format: 'cjs',
      target: ['node20'],
      external: ['electron'],
      outfile: 'dist/preload/index.js'
    }
  },
  {
    name: 'renderer',
    options: {
      ...common,
      entryPoints: ['src/main.ts'],
      platform: 'browser',
      format: 'iife',
      outfile: 'dist/renderer/bundle.js'
    }
  }
]

function copyStatic() {
  mkdirSync('dist/renderer', { recursive: true })
  cpSync('src/index.html', 'dist/renderer/index.html')
}

if (watch) {
  const ctxs = await Promise.all(targets.map((t) => context(t.options)))
  copyStatic()
  await Promise.all(ctxs.map((c) => c.watch()))
  console.log('watching for changes...')
} else {
  for (const t of targets) {
    await build(t.options)
  }
  copyStatic()
  console.log('build done -> dist/')
}
