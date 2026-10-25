import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { attachBackend, registerBackendIPC } from './ipc'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

async function createWindow() {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.resolve(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })

  attachBackend(window, path.resolve(__dirname, 'renderer/index.html'))

  if (process.env.NASTI_DEV_SERVER_URL) {
    await window.loadURL(process.env.NASTI_DEV_SERVER_URL)
  } else {
    await window.loadFile(path.resolve(__dirname, 'renderer/index.html'))
  }
}

app.whenReady().then(() => {
  registerBackendIPC()
  void createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
