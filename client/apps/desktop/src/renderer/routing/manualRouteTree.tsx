import { createRootRoute, createRoute, redirect } from '@tanstack/react-router'
import { App } from '../App'

const rootRoute = createRootRoute({
  component: App,
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/agent', replace: true })
  },
})

const agentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/agent',
})

const editRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/edit',
})

/**
 * Code-based equivalent of the generated route tree. Keep this contract in
 * sync with `routes/` so hosts can opt out of file route generation.
 */
export const manualRouteTree = rootRoute.addChildren([indexRoute, agentRoute, editRoute])
