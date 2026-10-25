import {
  ArrowRight,
  ArrowUp,
  ChevronRight,
  Code,
  Comment,
  FileCode,
  FolderOpen,
  Gear,
  LayoutSideContentLeft,
  Plus,
  Xmark,
} from '@gravity-ui/icons'
import { Button } from '@heroui/react/button'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import wudangMark from '../../../../../assets/double-slash.svg?url'
import { CodeEditor, type CursorPosition } from './CodeEditor'
import { OpenDocumentDialog } from './OpenDocumentDialog'
import { SettingsPage, type SettingsSection, type Theme } from './SettingsPage'
import { WorkspaceSidebar } from './WorkspaceSidebar'
import { useServerWorkspace } from './useServerWorkspace'

type WorkspaceMode = 'edit' | 'agent'

function getInitialTheme(): Theme {
  const stored = localStorage.getItem('wudang-theme')
  if (stored === 'light' || stored === 'dark') return stored
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export function App() {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const navigate = useNavigate()
  const isSettings = pathname === '/settings'
  const mode: WorkspaceMode = pathname === '/agent' ? 'agent' : 'edit'
  const previousMode = useRef<WorkspaceMode>('edit')
  const [theme, setTheme] = useState<Theme>(getInitialTheme)
  const [sidebarVisible, setSidebarVisible] = useState(true)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('account')
  const [openDialog, setOpenDialog] = useState(false)
  const [cursor, setCursor] = useState<CursorPosition>({ line: 1, utf16Column: 1, utf8Offset: 0 })
  const workspace = useServerWorkspace()

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    document.documentElement.classList.toggle('light', theme === 'light')
    document.documentElement.dataset.theme = theme
    localStorage.setItem('wudang-theme', theme)
  }, [theme])

  useEffect(() => {
    if (!isSettings) previousMode.current = mode
  }, [isSettings, mode])

  function showSettings(section: SettingsSection = 'account') {
    setSettingsSection(section)
    void navigate({ to: '/settings' })
  }

  function openDocument() {
    if (!workspace.user) showSettings()
    else setOpenDialog(true)
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.key === ',') {
        event.preventDefault()
        showSettings()
      } else if (event.key.toLowerCase() === 'o') {
        event.preventDefault()
        openDocument()
      } else if (event.key.toLowerCase() === 'b') {
        event.preventDefault()
        setSidebarVisible((visible) => !visible)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  return (
    <main className="app-shell" data-sidebar={sidebarVisible}>
      <header className="titlebar">
        <div className="titlebar-leading">
          <Button
            aria-label="Toggle sidebar"
            aria-expanded={sidebarVisible}
            className="icon-button"
            isIconOnly
            size="sm"
            variant="ghost"
            onPress={() => setSidebarVisible((visible) => !visible)}
          >
            <LayoutSideContentLeft aria-hidden />
          </Button>
          <span className="window-title">Wudang</span>
        </div>
        <span className="window-context">{workspace.document?.workspaceId ?? 'Workspace'}</span>
        <Button
          aria-label="Open settings"
          className="icon-button"
          isIconOnly
          size="sm"
          variant="ghost"
          onPress={() => showSettings()}
        >
          <Gear aria-hidden />
        </Button>
      </header>
      <div className="workspace">
        {sidebarVisible && (
          <WorkspaceSidebar
            workspace={workspace}
            activeView={isSettings ? 'settings' : mode}
            onNavigate={(next) => void navigate({ to: next === 'edit' ? '/edit' : '/agent' })}
            onSettings={showSettings}
            onOpenDocument={openDocument}
          />
        )}
        <div className="workspace-content">
          <div className="tab-strip">
            <div className="file-tab active">
              {isSettings ? (
                <Gear aria-hidden />
              ) : mode === 'agent' ? (
                <Comment aria-hidden />
              ) : (
                <FileCode aria-hidden />
              )}
              <span>
                {isSettings
                  ? 'Settings'
                  : mode === 'agent'
                    ? 'New thread'
                    : (workspace.document?.documentId ?? 'Welcome')}
              </span>
              {!isSettings && mode === 'edit' && workspace.dirty && (
                <span className="dirty-indicator" title="Unsaved changes" />
              )}
              {isSettings && (
                <Button
                  aria-label="Close settings"
                  className="tab-close"
                  isIconOnly
                  size="sm"
                  variant="ghost"
                  onPress={() =>
                    void navigate({ to: previousMode.current === 'edit' ? '/edit' : '/agent' })
                  }
                >
                  <Xmark aria-hidden />
                </Button>
              )}
            </div>
            <div className="tab-actions">
              {!isSettings && mode === 'edit' && workspace.document && (
                <Button
                  className="compact-button"
                  size="sm"
                  variant="ghost"
                  isDisabled={
                    !workspace.dirty || !workspace.live || workspace.busy || workspace.remoteChanged
                  }
                  onPress={() => void workspace.save()}
                >
                  Save
                </Button>
              )}
              {!isSettings && (
                <Button
                  aria-label="Open document"
                  className="icon-button"
                  isIconOnly
                  size="sm"
                  variant="ghost"
                  onPress={openDocument}
                >
                  <Plus aria-hidden />
                </Button>
              )}
            </div>
          </div>
          {workspace.error && !openDialog && (
            <p className="workspace-notice error-notice" role="alert">
              {workspace.error}
            </p>
          )}
          {workspace.remoteChanged && (
            <div className="workspace-notice" role="status">
              <span>
                Remote changes arrived. Your unsaved draft is preserved. Copy it before reopening.
              </span>
              <Button className="compact-button" size="sm" variant="ghost" onPress={openDocument}>
                Reopen document
              </Button>
            </div>
          )}
          {workspace.document && !workspace.live && !workspace.remoteChanged && (
            <div className="workspace-notice" role="status">
              <span>Connection lost. Your draft is preserved and editing is paused.</span>
              <Button className="compact-button" size="sm" variant="ghost" onPress={openDocument}>
                Reconnect
              </Button>
            </div>
          )}
          {isSettings ? (
            <SettingsPage
              workspace={workspace}
              section={settingsSection}
              onSectionChange={setSettingsSection}
              theme={theme}
              onThemeChange={setTheme}
            />
          ) : mode === 'edit' ? (
            workspace.document ? (
              <section
                className="editor-pane"
                aria-label="Edit workspace"
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
                    event.preventDefault()
                    if (
                      workspace.dirty &&
                      workspace.live &&
                      !workspace.busy &&
                      !workspace.remoteChanged
                    )
                      void workspace.save()
                  }
                }}
              >
                <div className="editor-breadcrumbs">
                  <span>{workspace.document.workspaceId}</span>
                  <ChevronRight aria-hidden />
                  <span>{workspace.document.documentId}</span>
                </div>
                <div className="editor-content">
                  <CodeEditor
                    ariaLabel={`${workspace.document.documentId} source editor`}
                    readOnly={workspace.busy || !workspace.live}
                    value={workspace.draft}
                    onChange={workspace.edit}
                    onCursorChange={setCursor}
                  />
                </div>
              </section>
            ) : (
              <section className="welcome-pane" aria-label="Welcome">
                <div className="welcome-content">
                  <img className="welcome-mark" alt="" src={wudangMark} />
                  <h1>A space for your best work.</h1>
                  <p>Open a document. Find your flow.</p>
                  <div className="welcome-actions">
                    <Button variant="ghost" onPress={openDocument}>
                      <FolderOpen aria-hidden />
                      Open document<kbd>⌘ O</kbd>
                    </Button>
                    <Button variant="ghost" onPress={() => showSettings()}>
                      <Gear aria-hidden />
                      Workspace settings<kbd>⌘ ,</kbd>
                    </Button>
                    <Button variant="ghost" onPress={() => void navigate({ to: '/agent' })}>
                      <Comment aria-hidden />
                      Explore agent threads
                      <ArrowRight aria-hidden />
                    </Button>
                  </div>
                  {!workspace.available && (
                    <p className="preview-caption">
                      Browser preview · Open the desktop app to connect your account.
                    </p>
                  )}
                </div>
              </section>
            )
          ) : (
            <section className="thread-pane" aria-label="Agent workspace">
              <div className="thread-empty">
                <span className="thread-symbol">
                  <Comment aria-hidden />
                </span>
                <h1>Good work starts with a conversation.</h1>
                <p>A place to think through ideas and work on code, together.</p>
                <span className="preview-label">Preview · Agent runs are not available yet</span>
              </div>
              <div className="composer">
                <textarea
                  aria-label="Message the agent"
                  disabled
                  placeholder="What would you like to work on?"
                  rows={3}
                />
                <div className="composer-footer">
                  <span>
                    <Code aria-hidden />
                    {workspace.document?.workspaceId ?? 'No workspace selected'}
                  </span>
                  <Button
                    aria-label="Send message"
                    isDisabled
                    isIconOnly
                    size="sm"
                    variant="secondary"
                  >
                    <ArrowUp aria-hidden />
                  </Button>
                </div>
              </div>
            </section>
          )}
        </div>
      </div>
      <footer className="statusbar">
        <span className="sync-state" role="status">
          <span className="sync-dot" data-live={workspace.live} />
          {workspace.live
            ? 'Connected'
            : workspace.document
              ? 'Offline'
              : workspace.user
                ? 'Signed in'
                : 'Not connected'}
        </span>
        {workspace.document && (
          <span className="status-ready">
            {workspace.dirty ? 'Unsaved draft' : 'Saved on server'}
          </span>
        )}
        <span className="statusbar-spacer" />
        {!isSettings && mode === 'edit' && workspace.document && (
          <>
            <span>
              Ln {cursor.line}, Col {cursor.utf16Column}
            </span>
            <span>UTF-8</span>
            <span>TSX</span>
          </>
        )}
        <span>Wudang</span>
      </footer>
      <OpenDocumentDialog
        workspace={workspace}
        open={openDialog}
        onClose={() => setOpenDialog(false)}
        onOpened={() => void navigate({ to: '/edit' })}
      />
    </main>
  )
}
