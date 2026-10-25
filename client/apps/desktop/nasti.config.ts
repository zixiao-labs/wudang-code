import { defineConfig } from '@nasti-toolchain/nasti'

export default defineConfig({
  target: 'electron',
  framework: 'react',
  electron: {
    main: 'src/electron/main.ts',
    preload: 'src/electron/preload.ts',
    renderer: 'src/renderer/index.html',
    mainFormat: 'esm',
    preloadFormat: 'cjs',
    nodeTarget: 'node22',
    autoRestart: true,
    minVersion: 41,
    external: ['electron'],
  },
})
