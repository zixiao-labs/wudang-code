import path from 'node:path'
import {
  Generator,
  getConfig,
  resolveConfigPath,
  type Config as RouterGeneratorConfig,
  type GeneratorEvent,
} from '@tanstack/router-generator'
import type { DevServer, Logger, NastiPlugin, ResolvedConfig } from '@nasti-toolchain/nasti'

export type RouterMode = 'file' | 'manual'

export type TanStackRouterPluginOptions = Partial<RouterGeneratorConfig> & {
  /**
   * Exposed to the client through `virtual:nasti-tanstack-router`.
   * `file` consumes the generated tree; `manual` uses the app's code-based tree.
   */
  routerMode?: RouterMode
}

type WatchEvent = 'add' | 'change' | 'unlink'

const watchEventToGeneratorEvent = {
  add: 'create',
  change: 'update',
  unlink: 'delete',
} as const

/**
 * Generates TanStack Router's file route tree before Nasti transforms the app.
 *
 * The plugin deliberately owns only route generation. Router history and the
 * choice between generated and code-based route trees stay in application code.
 */
export function tanStackRouterPlugin(options: TanStackRouterPluginOptions = {}): NastiPlugin {
  const { routerMode = 'file', ...generatorOptions } = options
  let root = process.cwd()
  let generator: Generator | undefined
  let generatorConfig: RouterGeneratorConfig | undefined
  let logger: Logger | undefined
  let queue = Promise.resolve()

  const initialize = (nextRoot = root) => {
    root = nextRoot
    generatorConfig = getConfig({ target: 'react', ...generatorOptions }, root)
    generator = new Generator({ config: generatorConfig, root })
  }

  const isRelevantFile = (file: string) => {
    if (!generatorConfig) {
      return false
    }

    const absoluteFile = path.resolve(file)
    const routesDirectory = path.resolve(root, generatorConfig.routesDirectory)
    const configFile = resolveConfigPath({ configDirectory: root })

    return absoluteFile === configFile || absoluteFile.startsWith(`${routesDirectory}${path.sep}`)
  }

  const run = async (event?: GeneratorEvent) => {
    if (!generator) {
      initialize()
    }

    await generator!.run(event)
  }

  const enqueue = (event?: GeneratorEvent) => {
    const nextRun = queue.catch(() => undefined).then(() => run(event))
    queue = nextRun.then(
      () => undefined,
      () => undefined,
    )
    return nextRun
  }

  const handleWatchEvent = async (file: string, watchEvent: WatchEvent) => {
    if (!isRelevantFile(file)) {
      return
    }

    const configFile = resolveConfigPath({ configDirectory: root })
    if (path.resolve(file) === configFile) {
      initialize()
      await enqueue()
      return
    }

    await enqueue({
      path: path.resolve(file),
      type: watchEventToGeneratorEvent[watchEvent],
    })
  }

  const reportWatchError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    logger?.error(`[tanstack-router] ${message}`)
  }

  return {
    name: 'wudang:tanstack-router',
    enforce: 'pre',
    resolveId(source) {
      return source === 'virtual:nasti-tanstack-router' ? '\0virtual:nasti-tanstack-router' : null
    },
    load(id) {
      if (id !== '\0virtual:nasti-tanstack-router') {
        return null
      }

      return `export const routerMode = ${JSON.stringify(routerMode)}`
    },
    async configResolved(config: ResolvedConfig) {
      logger = config.logger
      initialize(config.root)
      await enqueue()
    },
    async buildStart() {
      await enqueue()
    },
    configureServer(server: DevServer) {
      const listeners = (['add', 'change', 'unlink'] as const).map((event) => {
        const listener = (file: string) => {
          void handleWatchEvent(file, event).catch(reportWatchError)
        }
        server.watcher.on(event, listener)
        return { event, listener }
      })

      return () => {
        for (const { event, listener } of listeners) {
          server.watcher.off(event, listener)
        }
      }
    },
  }
}
