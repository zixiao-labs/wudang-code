import { createHashHistory, createRouter } from '@tanstack/react-router'
import { routerMode as configuredRouterMode } from 'virtual:nasti-tanstack-router'
import { routeTree as fileRouteTree } from '../routeTree.gen'
import { manualRouteTree } from './manualRouteTree'

export type RouterMode = 'file' | 'manual'

export const routerMode: RouterMode = configuredRouterMode

function createFileRouter() {
  return createRouter({
    routeTree: fileRouteTree,
    history: createHashHistory(),
    defaultPreload: 'intent',
  })
}

export type ApplicationRouter = ReturnType<typeof createFileRouter>

function createManualRouter(): ApplicationRouter {
  // Both trees implement the same route contract (`/`, `/agent`, `/edit`).
  // The generated tree remains the registered type source for file-route DX.
  return createRouter({
    routeTree: manualRouteTree,
    history: createHashHistory(),
    defaultPreload: 'intent',
  }) as unknown as ApplicationRouter
}

export const router = routerMode === 'manual' ? createManualRouter() : createFileRouter()

declare module '@tanstack/react-router' {
  interface Register {
    router: ApplicationRouter
  }
}
