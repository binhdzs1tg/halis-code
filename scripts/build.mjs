import { build, context } from 'esbuild'
import { cpSync, mkdirSync, watch } from 'node:fs'
import path from 'node:path'

const watchMode = process.argv.includes('--watch')

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  target: 'es2023'
}

// Fonts and brand images ride the CSS url() paths and land next to the
// bundle in dist/renderer, which is exactly where the relative url()s look.
const assetLoader = {
  '.png': 'file',
  '.woff2': 'file',
  '.woff': 'file',
  '.svg': 'file'
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
      loader: assetLoader,
      outfile: 'dist/renderer/bundle.js'
    }
  }
]

function copyStatic() {
  mkdirSync('dist/renderer', { recursive: true })
  cpSync('src/index.html', 'dist/renderer/index.html')
  mkdirSync('dist/main/models-dev', { recursive: true })
  cpSync('electron/main/models-dev/snapshot.json', 'dist/main/models-dev/snapshot.json')
}

const STATIC_SOURCES = [
  ['src/index.html', 'dist/renderer/index.html'],
  ['electron/main/models-dev/snapshot.json', 'dist/main/models-dev/snapshot.json']
]

/** Neither file is an esbuild input, so watch mode must copy it itself.
 *  Watch the parent directory, not the file: editors save through
 *  write-temp-then-rename, which orphans a file watcher on the old inode
 *  and the copy then silently stops working. */
function watchStatic() {
  const dirs = new Map()
  for (const [from] of STATIC_SOURCES) {
    const dir = path.dirname(from)
    if (!dirs.has(dir)) dirs.set(dir, [])
    dirs.get(dir).push(path.basename(from))
  }
  for (const [dir, names] of dirs) {
    try {
      watch(dir, (_event, filename) => {
        if (filename && !names.includes(filename)) return
        try {
          copyStatic()
          console.log(`static change copied in ${dir}`)
        } catch (err) {
          console.warn(`copy failed for ${dir}:`, err?.message ?? err)
        }
      })
    } catch {
      // Watching is best effort; the bundle still works.
    }
  }
}

if (watchMode) {
  const ctxs = await Promise.all(targets.map((t) => context(t.options)))
  copyStatic()
  watchStatic()
  await Promise.all(ctxs.map((c) => c.watch()))
  console.log('watching for changes...')
} else {
  for (const t of targets) {
    await build(t.options)
  }
  copyStatic()
  console.log('build done -> dist/')
}
