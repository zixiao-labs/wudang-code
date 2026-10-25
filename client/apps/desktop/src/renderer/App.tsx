import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Code,
  Comment,
  FileCode,
  FolderOpen,
  Moon,
  Paperclip,
  Sparkles,
  Sun,
} from '@gravity-ui/icons'
import { Button } from '@heroui/react/button'
import { TextArea } from '@heroui/react/textarea'
import { TextField } from '@heroui/react/textfield'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import wudangMark from '../../../../../assets/double-slash.svg?url'
import { CodeEditor, type CursorPosition } from './CodeEditor'
import { ConnectionPanel } from './ConnectionPanel'
import { useServerWorkspace } from './useServerWorkspace'

type WorkspaceMode = 'edit' | 'agent'
type Theme = 'light' | 'dark'

const routeByMode = {
  edit: '/edit',
  agent: '/agent',
} as const

function getInitialTheme(): Theme {
  const storedTheme = localStorage.getItem('wudang-theme')
  if (storedTheme === 'light' || storedTheme === 'dark') {
    return storedTheme
  }

  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export function App() {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const navigate = useNavigate()
  const mode: WorkspaceMode = pathname === routeByMode.edit ? 'edit' : 'agent'
  const [theme, setTheme] = useState<Theme>(getInitialTheme)
  const [showDiff, setShowDiff] = useState(true)
  const [cursor, setCursor] = useState<CursorPosition>({
    line: 1,
    utf16Column: 1,
    utf8Offset: 0,
  })
  const workspace = useServerWorkspace()

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    document.documentElement.classList.toggle('light', theme === 'light')
    document.documentElement.dataset.theme = theme
    localStorage.setItem('wudang-theme', theme)
  }, [theme])

  const setMode = (nextMode: WorkspaceMode) => {
    void navigate({ to: routeByMode[nextMode] })
  }

  const openAppliedChange = () => {
    setMode('edit')
  }

  return (
    <main className="app-shell">
      <header className="titlebar">
        <div className="brand">
          <span className="brand-mark-wrap">
            <img alt="" className="brand-mark" src={wudangMark} />
          </span>
          <div className="brand-copy">
            <strong>Wudang</strong>
            <span>agent workspace</span>
          </div>
        </div>

        <nav className="mode-switcher" aria-label="Workspace view">
          <Button
            aria-current={mode === 'edit' ? 'page' : undefined}
            className="mode-button"
            data-active={mode === 'edit'}
            size="sm"
            variant="ghost"
            onPress={() => setMode('edit')}
          >
            <Code aria-hidden />
            Edit
          </Button>
          <Button
            aria-current={mode === 'agent' ? 'page' : undefined}
            className="mode-button"
            data-active={mode === 'agent'}
            size="sm"
            variant="ghost"
            onPress={() => setMode('agent')}
          >
            <Sparkles aria-hidden />
            Agent
          </Button>
        </nav>

        <div className="titlebar-actions">
          <span className="sync-state" role="status">
            <span className="sync-dot" data-live={workspace.live} />
            {workspace.live ? 'CRDT connected' : 'Offline'}
          </span>
          <span className="titlebar-divider" />
          <Button
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            className="icon-button"
            isIconOnly
            size="sm"
            variant="ghost"
            onPress={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
          >
            {theme === 'dark' ? <Sun aria-hidden /> : <Moon aria-hidden />}
          </Button>
        </div>
      </header>

      <div className="workspace">
        <ConnectionPanel workspace={workspace} onOpen={() => setMode('edit')} />

        {mode === 'edit' ? (
          workspace.document ? (
            <EditorWorkspace
              cursor={cursor}
              source={workspace.draft}
              onCursorChange={setCursor}
              onSourceChange={workspace.edit}
              documentId={workspace.document.documentId}
              version={workspace.document.version}
              dirty={workspace.dirty}
              readOnly={workspace.busy || !workspace.live}
              canSave={
                workspace.dirty && workspace.live && !workspace.busy && !workspace.remoteChanged
              }
              onSave={() => void workspace.save()}
            />
          ) : (
            <section className="workspace-empty" aria-label="Open a server document">
              <span className="workspace-empty-icon">
                <FolderOpen aria-hidden />
              </span>
              <span className="eyebrow">A SHARED STARTING POINT</span>
              <h1>Your workspace, connected.</h1>
              <p>
                Sign in to your server, then open a document from the sidebar.
                <br />
                Edits are saved to the server, not a demo buffer.
              </p>
              <div className="workspace-empty-steps">
                <span>01 · Connect</span>
                <ChevronRight aria-hidden />
                <span>02 · Open</span>
                <ChevronRight aria-hidden />
                <span>03 · Collaborate</span>
              </div>
            </section>
          )
        ) : (
          <section className="agent-mode" aria-label="Agent workspace">
            <div className="thread-pane">
              <div className="thread-header">
                <div className="pane-title">
                  <span className="eyebrow">DEMO THREAD · T-01J8K</span>
                  <h1>Stream collaborative edits</h1>
                  <p>UI preview · Agent Run service is not connected</p>
                </div>
                <span className="run-state">
                  <CircleCheck aria-hidden />
                  Demo
                </span>
              </div>

              <div className="messages" aria-live="polite">
                <article className="message user-message">
                  <header>
                    <span className="message-avatar user-avatar">Y</span>
                    <strong>You</strong>
                    <time>20:17</time>
                  </header>
                  <p>
                    Add a streaming CRDT collaboration protocol and show the applied patch as a
                    reviewable diff.
                  </p>
                </article>

                <article className="message agent-message">
                  <header>
                    <span className="message-avatar agent-avatar">
                      <img alt="" src={wudangMark} />
                    </span>
                    <strong>Wudang</strong>
                    <span className="agent-badge">worker</span>
                    <time>20:18</time>
                  </header>
                  <p>
                    Added a bidirectional document stream with causal deltas, stable anchors, and
                    reconnect support. I also wired the resulting change set into Agent review.
                  </p>

                  <button
                    aria-expanded={showDiff}
                    className="tool-call"
                    type="button"
                    onClick={() => setShowDiff((visible) => !visible)}
                  >
                    <span className="tool-icon">
                      <Code aria-hidden />
                    </span>
                    <span className="tool-copy">
                      <strong>Applied patch</strong>
                      <small>client/apps/desktop/src/renderer/App.tsx</small>
                    </span>
                    <span className="diff-stats" aria-label="18 additions, 4 deletions">
                      <span className="addition">+18</span>
                      <span className="deletion">−4</span>
                    </span>
                    <span className="tool-status">
                      <Check aria-hidden />
                      Applied
                    </span>
                    {showDiff ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
                  </button>

                  <div className="verification">
                    <span className="verification-icon">
                      <CircleCheck aria-hidden />
                    </span>
                    <div>
                      <strong>Validation passed</strong>
                      <small>pnpm typecheck · protoc contract check</small>
                    </div>
                  </div>
                </article>
              </div>

              <form className="composer" onSubmit={(event) => event.preventDefault()}>
                <TextField aria-label="Message the agent" className="composer-field" isDisabled>
                  <TextArea
                    className="composer-input"
                    placeholder="Agent runs are not available on this server yet"
                    rows={3}
                    variant="secondary"
                  />
                </TextField>
                <div className="composer-actions">
                  <div className="composer-tools">
                    <Button
                      aria-label="Attach context"
                      className="composer-icon-button"
                      isIconOnly
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      <Paperclip aria-hidden />
                    </Button>
                    <span>Demo · not sent to server</span>
                  </div>
                  <div className="send-group">
                    <span>⌘ ↵</span>
                    <Button className="send-button" isDisabled size="sm" type="submit">
                      Send
                      <ArrowRight aria-hidden />
                    </Button>
                  </div>
                </div>
              </form>
            </div>

            <ReviewPane
              showDiff={showDiff}
              onOpenAppliedChange={openAppliedChange}
              onShowDiff={() => setShowDiff(true)}
            />
          </section>
        )}
      </div>
    </main>
  )
}

interface EditorWorkspaceProps {
  cursor: CursorPosition
  source: string
  onCursorChange: (cursor: CursorPosition) => void
  onSourceChange: (source: string) => void
  documentId: string
  version: string
  dirty: boolean
  readOnly: boolean
  canSave: boolean
  onSave: () => void
}

function EditorWorkspace({
  cursor,
  source,
  onCursorChange,
  onSourceChange,
  documentId,
  version,
  dirty,
  readOnly,
  canSave,
  onSave,
}: EditorWorkspaceProps) {
  return (
    <section
      className="editor-pane"
      aria-label="Edit workspace"
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 's') {
          event.preventDefault()
          if (canSave) onSave()
        }
      }}
    >
      <div className="tab-strip">
        <div className="file-tab active">
          <FileCode aria-hidden />
          <span>{documentId}</span>
          {dirty && <span className="dirty-indicator" title="Unsaved changes" />}
        </div>
        <div className="editor-breadcrumbs" aria-label="File location">
          <span>Server document</span>
          <ChevronRight aria-hidden />
          <strong>{documentId}</strong>
        </div>
        <Button
          className="document-save"
          size="sm"
          variant="secondary"
          isDisabled={!canSave}
          onPress={onSave}
        >
          Save
        </Button>
      </div>
      <div className="editor-content">
        <CodeEditor
          ariaLabel={`${documentId} source editor`}
          readOnly={readOnly}
          value={source}
          onChange={onSourceChange}
          onCursorChange={onCursorChange}
        />
      </div>
      <footer className="statusbar">
        <span className="status-ready">
          <CircleCheck aria-hidden />
          {dirty ? 'Unsaved draft' : 'Saved on server'} · {version.slice(0, 10)}
        </span>
        <span className="statusbar-spacer" />
        <span>UTF-8 {cursor.utf8Offset}</span>
        <span>
          Ln {cursor.line}, Col {cursor.utf16Column}
        </span>
        <span>TypeScript React</span>
      </footer>
    </section>
  )
}

interface ReviewPaneProps {
  showDiff: boolean
  onOpenAppliedChange: () => void
  onShowDiff: () => void
}

function ReviewPane({ showDiff, onOpenAppliedChange, onShowDiff }: ReviewPaneProps) {
  return (
    <div className={`review-pane ${showDiff ? '' : 'review-pane-collapsed'}`}>
      {showDiff ? (
        <>
          <div className="review-header">
            <div className="pane-title">
              <span className="eyebrow">DEMO CHANGE SET · CS-0182</span>
              <h2>Review applied patch</h2>
              <p>App.tsx · Base rev 127</p>
            </div>
            <div className="review-actions">
              <Button size="sm" variant="ghost">
                <Comment aria-hidden />
                Comment
              </Button>
              <Button size="sm" variant="secondary" onPress={onOpenAppliedChange}>
                <Code aria-hidden />
                Go to Edit
              </Button>
            </div>
          </div>
          <div className="diff-summary">
            <span className="modified-badge">M</span>
            <FileCode aria-hidden />
            <code>client/apps/desktop/src/renderer/App.tsx</code>
            <span className="diff-stats">
              <span className="addition">+18</span>
              <span className="deletion">−4</span>
            </span>
          </div>
          <div className="diff-editor">
            <CodeEditor
              ariaLabel="Applied patch diff for App.tsx"
              diffOriginal={originalSource}
              readOnly
              value={updatedSource}
            />
          </div>
          <footer className="review-footer">
            <span>Base 127</span>
            <ArrowRight aria-hidden />
            <span>Head 128</span>
            <span className="statusbar-spacer" />
            <span className="immutable-state">
              <Check aria-hidden />
              Immutable review anchor
            </span>
          </footer>
        </>
      ) : (
        <div className="collapsed-review-content">
          <Code aria-hidden />
          <strong>Patch review hidden</strong>
          <span>The applied change remains anchored to rev 128.</span>
          <Button size="sm" variant="secondary" onPress={onShowDiff}>
            Show applied patch
          </Button>
        </div>
      )}
    </div>
  )
}

const originalSource = `import { Button } from '@heroui/react'

export function App() {
  return (
    <main>
      <h1>Wudang</h1>
      <Button>Start a thread</Button>
    </main>
  )
}
`

const updatedSource = `import { Button } from '@heroui/react'
import { useState } from 'react'

type WorkspaceMode = 'edit' | 'agent'

export function App() {
  const [mode, setMode] = useState<WorkspaceMode>('agent')

  return (
    <main data-mode={mode}>
      <header>
        <h1>Wudang</h1>
        <nav aria-label="Workspace mode">
          <Button onPress={() => setMode('edit')}>Edit</Button>
          <Button onPress={() => setMode('agent')}>Agent</Button>
        </nav>
      </header>
      <section aria-live="polite">
        {mode === 'edit' ? 'Source editor' : 'Agent thread'}
      </section>
    </main>
  )
}
`
