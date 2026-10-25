import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { pathToFileURL } from 'node:url'
import { Backend } from './backend'
import type { DesktopAPI, Result } from '../shared/desktop'

const hosts = new Map<number, { backend: Backend; url: string }>()

export function attachBackend(window: BrowserWindow, rendererFile: string) {
  const backend = new Backend((event) => {
    if (!window.isDestroyed()) window.webContents.send('wudang:document', event)
  })
  hosts.set(window.webContents.id, {
    backend,
    url: process.env.NASTI_DEV_SERVER_URL ?? pathToFileURL(rendererFile).href,
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('render-process-gone', () => backend.dispose())
  window.on('closed', () => {
    backend.dispose()
    hosts.delete(window.webContents.id)
  })
}

function host(event: IpcMainInvokeEvent) {
  const entry = hosts.get(event.sender.id)
  const frame = event.senderFrame
  if (!entry || !frame || frame !== event.sender.mainFrame) throw new Error('Untrusted IPC sender.')
  const actual = new URL(frame.url)
  const expected = new URL(entry.url)
  if (
    actual.protocol === 'file:'
      ? actual.pathname !== expected.pathname || expected.protocol !== 'file:'
      : actual.origin !== expected.origin
  ) {
    throw new Error('Untrusted IPC origin.')
  }
  return entry.backend
}

export function registerBackendIPC() {
  function handle<K extends Exclude<keyof DesktopAPI, 'onDocument'>>(
    name: K,
    run: (backend: Backend, input: Parameters<DesktopAPI[K]>[0]) => unknown,
  ) {
    ipcMain.handle(`wudang:${name}`, async (event, input): Promise<Result<unknown>> => {
      try {
        return { ok: true, value: await run(host(event), input) }
      } catch (error) {
        // Never serialize gRPC metadata, stacks, passwords or Session objects.
        return { ok: false, error: error instanceof Error ? error.message : 'Request failed.' }
      }
    })
  }
  handle('session', (backend) => backend.session())
  handle('login', (backend, input) => backend.login(input))
  handle('logout', (backend) => backend.logout())
  handle('listRepositories', (backend, input) => backend.listRepositories(input))
  handle('createRepository', (backend, input) => backend.createRepository(input))
  handle('openDocument', (backend, input) => backend.openDocument(input))
  handle('saveDocument', (backend, input) => backend.saveDocument(input))
  handle('closeDocument', (backend) => backend.closeDocument())
}
