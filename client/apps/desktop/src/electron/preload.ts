import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopAPI, DocumentEvent } from '../shared/desktop'

const desktop: DesktopAPI = {
  session: () => ipcRenderer.invoke('wudang:session'),
  login: (input) => ipcRenderer.invoke('wudang:login', input),
  logout: () => ipcRenderer.invoke('wudang:logout'),
  listRepositories: (input) => ipcRenderer.invoke('wudang:listRepositories', input),
  createRepository: (input) => ipcRenderer.invoke('wudang:createRepository', input),
  openDocument: (input) => ipcRenderer.invoke('wudang:openDocument', input),
  saveDocument: (input) => ipcRenderer.invoke('wudang:saveDocument', input),
  closeDocument: () => ipcRenderer.invoke('wudang:closeDocument'),
  onDocument: (callback) => {
    const listener = (_event: unknown, value: DocumentEvent) => callback(value)
    ipcRenderer.on('wudang:document', listener)
    return () => {
      ipcRenderer.removeListener('wudang:document', listener)
    }
  },
}
contextBridge.exposeInMainWorld('desktop', desktop)
