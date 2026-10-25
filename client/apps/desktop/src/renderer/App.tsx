import {
  ArrowRight,
  BranchesDown,
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Code,
  Comment,
  Ellipsis,
  File,
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
import { type FormEvent, useEffect, useState } from 'react'
import wudangMark from '../../../../../assets/double-slash.svg?url'
import { CodeEditor, type CursorPosition } from './CodeEditor'

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
  const [prompt, setPrompt] = useState('')
  const [cursor, setCursor] = useState<CursorPosition>({
    line: 1,
    utf16Column: 1,
    utf8Offset: 0,
  })
  const [source, setSource] = useState(updatedSource)

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
    setSource(updatedSource)
    setMode('edit')
  }

  const sendPrompt = (event: FormEvent) => {
    event.preventDefault()
    if (prompt.trim()) {
      setPrompt('')
    }
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
          <span className="sync-state">
            <span className="sync-dot" />
            CRDT live
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
        <ProjectSidebar />

        {mode === 'edit' ? (
          <EditorWorkspace
            cursor={cursor}
            source={source}
            onCursorChange={setCursor}
            onSourceChange={setSource}
          />
        ) : (
          <section className="agent-mode" aria-label="Agent workspace">
            <div className="thread-pane">
              <div className="thread-header">
                <div className="pane-title">
                  <span className="eyebrow">THREAD · T-01J8K</span>
                  <h1>Stream collaborative edits</h1>
                  <p>Implementing a reviewable CRDT workflow</p>
                </div>
                <span className="run-state">
                  <CircleCheck aria-hidden />
                  Run succeeded
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

              <form className="composer" onSubmit={sendPrompt}>
                <TextField
                  aria-label="Message the agent"
                  className="composer-field"
                  value={prompt}
                  onChange={setPrompt}
                >
                  <TextArea
                    className="composer-input"
                    placeholder="Ask Wudang to change, explain, or verify…"
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
                    <span>Workspace rev 128</span>
                  </div>
                  <div className="send-group">
                    <span>⌘ ↵</span>
                    <Button
                      className="send-button"
                      isDisabled={!prompt.trim()}
                      size="sm"
                      type="submit"
                    >
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

function ProjectSidebar() {
  return (
    <aside className="project-sidebar">
      <div className="sidebar-heading">
        <span>EXPLORER</span>
        <Button
          aria-label="More project actions"
          className="sidebar-action"
          isIconOnly
          size="sm"
          variant="ghost"
        >
          <Ellipsis aria-hidden />
        </Button>
      </div>
      <div className="repository-name">
        <ChevronDown aria-hidden />
        <strong>wudang</strong>
        <span className="repository-visibility">LOCAL</span>
      </div>
      <nav aria-label="Project files" className="file-tree">
        <FileItem depth={0} label="client" kind="folder" />
        <FileItem depth={1} label="apps" kind="folder" />
        <FileItem depth={2} label="desktop" kind="folder" />
        <FileItem active depth={3} label="App.tsx" kind="tsx" />
        <FileItem depth={3} label="CodeEditor.tsx" kind="tsx" />
        <FileItem depth={3} label="globals.css" kind="css" />
        <FileItem depth={0} label="proto" kind="folder" />
        <FileItem depth={1} label="auth.proto" kind="proto" />
        <FileItem depth={1} label="collab.proto" kind="proto" />
        <FileItem depth={1} label="sync.proto" kind="proto" />
        <FileItem depth={0} label="docs" kind="folder" />
      </nav>
      <div className="sidebar-footer">
        <span>
          <BranchesDown aria-hidden />
          main
        </span>
        <span className="change-count">1 change</span>
      </div>
    </aside>
  )
}

interface EditorWorkspaceProps {
  cursor: CursorPosition
  source: string
  onCursorChange: (cursor: CursorPosition) => void
  onSourceChange: (source: string) => void
}

function EditorWorkspace({ cursor, source, onCursorChange, onSourceChange }: EditorWorkspaceProps) {
  return (
    <section className="editor-pane" aria-label="Edit workspace">
      <div className="tab-strip">
        <div className="file-tab active">
          <FileCode aria-hidden />
          <span>App.tsx</span>
          <span className="dirty-indicator" title="Unsaved changes" />
        </div>
        <div className="editor-breadcrumbs" aria-label="File location">
          <span>client</span>
          <ChevronRight aria-hidden />
          <span>desktop</span>
          <ChevronRight aria-hidden />
          <strong>App.tsx</strong>
        </div>
      </div>
      <div className="editor-content">
        <CodeEditor
          ariaLabel="App.tsx source editor"
          value={source}
          onChange={onSourceChange}
          onCursorChange={onCursorChange}
        />
      </div>
      <footer className="statusbar">
        <span className="status-ready">
          <CircleCheck aria-hidden />
          Workspace rev 128
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
              <span className="eyebrow">CHANGE SET · CS-0182</span>
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
                Open in Edit
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

interface FileItemProps {
  active?: boolean
  depth: number
  kind: 'folder' | 'tsx' | 'css' | 'proto'
  label: string
}

function FileItem({ active = false, depth, kind, label }: FileItemProps) {
  const fileIcon =
    kind === 'folder' ? (
      <>
        <ChevronDown aria-hidden className="tree-chevron" />
        <FolderOpen aria-hidden className="folder-icon" />
      </>
    ) : kind === 'tsx' ? (
      <FileCode aria-hidden />
    ) : (
      <File aria-hidden />
    )

  return (
    <button
      aria-current={active ? 'page' : undefined}
      className={`file-item ${active ? 'active' : ''}`}
      style={{ paddingLeft: `${10 + depth * 14}px` }}
      type="button"
    >
      <span className={`file-symbol ${kind}`}>{fileIcon}</span>
      <span className="file-label">{label}</span>
      {active ? <span className="active-file-marker" /> : null}
    </button>
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
