# `@wudang/nasti-plugin-tanstack-router`

Nasti adapter for TanStack Router file-based route generation.

```ts
import { tanStackRouterPlugin } from '@wudang/nasti-plugin-tanstack-router'

export default defineConfig({
  plugins: [
    tanStackRouterPlugin({
      routesDirectory: 'src/renderer/routes',
      generatedRouteTree: 'src/renderer/routeTree.gen.ts',
      routerMode: process.env.NASTI_ROUTER_MODE === 'manual' ? 'manual' : 'file',
    }),
  ],
})
```

The plugin runs `@tanstack/router-generator` before builds and watches route
creation, changes, and removal in development. Applications remain responsible
for creating the router and selecting browser, hash, or memory history. The
`virtual:nasti-tanstack-router` module exposes the configured `routerMode` so
the same app can switch between generated and code-based route trees.
