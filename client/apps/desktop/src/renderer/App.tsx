import { Button } from '@heroui/react/button'
import { TextArea } from '@heroui/react/textarea'
import { TextField } from '@heroui/react/textfield'
import { useEffect, useState } from 'react'
import { CodeEditor, type CursorPosition } from './CodeEditor'
import wudangMark from '../../../../../assets/double-slash.svg?url'

export function App() {
  const [mode, setMode] = useState<'edit' | 'agent'>('agent')
  const [theme, setTheme] = useState<'light' | 'dark'>('dark')
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
  }, [theme])

  const openAppliedChange = () => {
    setSource(updatedSource)
    setMode('edit')
  }

  return (
    <main className="app-shell">
      <header className="titlebar">
        <div className="brand">
          <img alt="" className="brand-mark" src={wudangMark} />
          <div>
            <strong>Wudang</strong>
            <span>agent workspace</span>
          </div>
        </div>

        <div className="mode-switcher" aria-label="Workspace mode">
          <Button
            aria-pressed={mode === 'edit'}
            className="mode-button"
            size="sm"
            variant={mode === 'edit' ? 'secondary' : 'ghost'}
            onPress={() => setMode('edit')}
          >
            Edit
          </Button>
          <Button
            aria-pressed={mode === 'agent'}
            className="mode-button"
            size="sm"
            variant={mode === 'agent' ? 'secondary' : 'ghost'}
            onPress={() => setMode('agent')}
          >
            Agent
          </Button>
        </div>

        <div className="titlebar-actions">
          <span className="sync-state">
            <span className="sync-dot" />
            CRDT live
          </span>
          <Button
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            isIconOnly
            size="sm"
            variant="ghost"
            onPress={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
          >
            {theme === 'dark' ? '☀' : '◐'}
          </Button>
        </div>
      </header>

      <div className="workspace">
        <aside className="project-sidebar">
          <div className="sidebar-heading">
            <span>EXPLORER</span>
            <button aria-label="More project actions" type="button">
              ···
            </button>
          </div>
          <div className="repository-name">
            <span className="chevron">⌄</span>
            <strong>wudang</strong>
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
            <span>main</span>
            <span>1 change</span>
          </div>
        </aside>

        {mode === 'edit' ? (
          <section className="editor-pane" aria-label="Edit mode">
            <div className="tab-strip">
              <div className="file-tab active">
                <span className="file-badge tsx">TSX</span>
                App.tsx
                <span className="dirty-indicator" title="Unsaved changes" />
              </div>
            </div>
            <div className="editor-content">
              <CodeEditor
                ariaLabel="App.tsx source editor"
                value={source}
                onChange={setSource}
                onCursorChange={setCursor}
              />
            </div>
            <footer className="statusbar">
              <span>Workspace rev 128</span>
              <span className="statusbar-spacer" />
              <span>UTF-8 {cursor.utf8Offset}</span>
              <span>
                Ln {cursor.line}, Col {cursor.utf16Column} UTF-16
              </span>
              <span>TypeScript React</span>
            </footer>
          </section>
        ) : (
          <section className="agent-mode" aria-label="Agent mode">
            <div className="thread-pane">
              <div className="thread-header">
                <div>
                  <span className="eyebrow">THREAD T-01J8K</span>
                  <h1>Stream collaborative edits</h1>
                </div>
                <span className="run-state">Run succeeded</span>
              </div>

              <div className="messages" aria-live="polite">
                <article className="message user-message">
                  <header>
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
                    <strong>Agent</strong>
                    <span className="agent-badge">worker</span>
                    <time>20:18</time>
                  </header>
                  <p>
                    Added a bidirectional document stream with causal deltas, stable anchors, and
                    reconnect support. I also wired the resulting Change Set into Agent review.
                  </p>

                  <button
                    aria-expanded={showDiff}
                    className="tool-call"
                    type="button"
                    onClick={() => setShowDiff((visible) => !visible)}
                  >
                    <span className="tool-icon">±</span>
                    <span className="tool-copy">
                      <strong>apply_patch</strong>
                      <small>client/apps/desktop/src/renderer/App.tsx</small>
                    </span>
                    <span className="diff-stats">
                      <span className="addition">+18</span>
                      <span className="deletion">−4</span>
                    </span>
                    <span className="tool-status">Applied</span>
                    <span className="chevron">{showDiff ? '⌃' : '⌄'}</span>
                  </button>

                  <div className="verification">
                    <span>✓</span>
                    <div>
                      <strong>Validation passed</strong>
                      <small>pnpm typecheck · protoc contract check</small>
                    </div>
                  </div>
                </article>
              </div>

              <div className="composer">
                <TextField
                  aria-label="Message the agent"
                  className="composer-field"
                  value={prompt}
                  onChange={setPrompt}
                >
                  <TextArea
                    className="composer-input"
                    placeholder="Ask the agent to change, explain, or verify…"
                    rows={3}
                  />
                </TextField>
                <div className="composer-actions">
                  <span>Workspace rev 128</span>
                  <Button
                    isDisabled={!prompt.trim()}
                    size="sm"
                    onPress={() => setPrompt('')}
                  >
                    Send
                  </Button>
                </div>
              </div>
            </div>

            <div className={`review-pane ${showDiff ? '' : 'review-pane-collapsed'}`}>
              {showDiff ? (
                <>
                  <div className="review-header">
                    <div>
                      <span className="eyebrow">CHANGE SET CS-0182</span>
                      <h2>App.tsx</h2>
                    </div>
                    <div className="review-actions">
                      <Button size="sm" variant="ghost">
                        Comment
                      </Button>
                      <Button size="sm" variant="secondary" onPress={openAppliedChange}>
                        Open in Edit
                      </Button>
                    </div>
                  </div>
                  <div className="diff-summary">
                    <span>M</span>
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
                    <span>Base rev 127</span>
                    <span>→</span>
                    <span>Head rev 128</span>
                    <span className="statusbar-spacer" />
                    <span>Unified diff · immutable review anchor</span>
                  </footer>
                </>
              ) : (
                <button className="collapsed-review-trigger" type="button" onClick={() => setShowDiff(true)}>
                  Show applied patch
                </button>
              )}
            </div>
          </section>
        )}
      </div>
    </main>
  )
}

interface FileItemProps {
  active?: boolean
  depth: number
  kind: 'folder' | 'tsx' | 'css' | 'proto'
  label: string
}

function FileItem({ active = false, depth, kind, label }: FileItemProps) {
  return (
    <button
      className={`file-item ${active ? 'active' : ''}`}
      style={{ paddingLeft: `${12 + depth * 14}px` }}
      type="button"
    >
      <span className={`file-symbol ${kind}`}>{kind === 'folder' ? '⌄' : kind.toUpperCase()}</span>
      <span>{label}</span>
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
