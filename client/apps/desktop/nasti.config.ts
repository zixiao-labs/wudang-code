import { defineConfig } from '@nasti-toolchain/nasti'
import { tanStackRouterPlugin } from '@wudang/nasti-plugin-tanstack-router'

export default defineConfig({
  target: 'electron',
  framework: 'react',
  plugins: [
    tanStackRouterPlugin({
      routesDirectory: 'src/renderer/routes',
      generatedRouteTree: 'src/renderer/routeTree.gen.ts',
      quoteStyle: 'single',
      routerMode: process.env.NASTI_ROUTER_MODE === 'manual' ? 'manual' : 'file',
      semicolons: false,
    }),
  ],
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
