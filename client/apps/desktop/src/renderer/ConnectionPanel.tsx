import { ArrowRight, FileCode, FolderOpen } from '@gravity-ui/icons'
import { Button } from '@heroui/react/button'
import { useState, type FormEvent } from 'react'
import type { ServerWorkspace } from './useServerWorkspace'

export function ConnectionPanel({
  workspace: w,
  onOpen,
}: {
  workspace: ServerWorkspace
  onOpen: () => void
}) {
  const [register, setRegister] = useState(false)
  const [organizationId, setOrganizationId] = useState('')
  const [loadedOrganization, setLoadedOrganization] = useState('')
  const [workspaceId, setWorkspaceId] = useState('')
  const [documentId, setDocumentId] = useState('')
  const [repositoryName, setRepositoryName] = useState('')

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const password = event.currentTarget.elements.namedItem('password') as HTMLInputElement
    const input = {
      endpoint: String(data.get('endpoint')),
      email: String(data.get('email')),
      password: password.value,
      displayName: String(data.get('displayName') ?? ''),
      register,
    }
    password.value = ''
    await w.login(input)
  }

  return (
    <aside className="project-sidebar connection-panel" aria-label="Server workspace">
      <div className="connection-heading">
        <span className="eyebrow">WORKSPACE</span>
        <h2>{w.user ? 'Your server' : 'Connect to Wudang'}</h2>
        <p>{w.user ? w.user.displayName : 'One workspace. A shared source of truth.'}</p>
      </div>
      {!w.available ? (
        <p className="connection-notice">
          Open the Electron app to connect. Browser preview has no access to credentials or gRPC.
        </p>
      ) : !w.user ? (
        <form className="connection-form" onSubmit={(event) => void login(event)}>
          <fieldset disabled={w.busy}>
            <label>
              Server address
              <input
                name="endpoint"
                type="url"
                defaultValue={w.endpoint}
                key={w.endpoint}
                required
                spellCheck={false}
              />
            </label>
            <label>
              Email
              <input name="email" type="email" autoComplete="username" required />
            </label>
            {register && (
              <label>
                Display name
                <input name="displayName" autoComplete="name" required />
              </label>
            )}
            <label>
              Password
              <input
                name="password"
                type="password"
                autoComplete={register ? 'new-password' : 'current-password'}
                minLength={register ? 12 : 1}
                required
              />
            </label>
            <Button fullWidth type="submit" isPending={w.busy}>
              {w.busy ? 'Connecting…' : register ? 'Create account' : 'Sign in'}
              <ArrowRight aria-hidden />
            </Button>
            <Button fullWidth variant="ghost" onPress={() => setRegister(!register)}>
              {register ? 'Already have an account?' : 'Create a local account'}
            </Button>
          </fieldset>
          <p className="connection-hint">
            Native gRPC · TLS for remote servers
            <br />
            Credentials stay in the desktop host.
          </p>
        </form>
      ) : (
        <div className="connection-sections">
          <div className="connection-account">
            <span title={w.endpoint}>{w.endpoint}</span>
            <Button
              size="sm"
              variant="ghost"
              isDisabled={w.busy}
              onPress={() => {
                if (!w.dirty || confirm('Discard your unsaved draft and sign out?')) void w.logout()
              }}
            >
              Sign out
            </Button>
          </div>
          <form
            className="connection-form"
            onSubmit={(event) => {
              event.preventDefault()
              setLoadedOrganization(organizationId)
              void w.list(organizationId)
            }}
          >
            <fieldset disabled={w.busy}>
              <legend>Repositories</legend>
              <label>
                Organization ID
                <input
                  value={organizationId}
                  onChange={(event) => setOrganizationId(event.target.value)}
                  placeholder="Organization UUID"
                  required
                />
              </label>
              <Button fullWidth type="submit" variant="secondary" isPending={w.busy}>
                Load repositories
              </Button>
            </fieldset>
          </form>
          {loadedOrganization === organizationId && (
            <nav className="server-repositories" aria-label="Server repositories">
              {w.repositories.map((repository) => (
                <div className="server-repository" key={repository.repositoryId}>
                  <FolderOpen aria-hidden />
                  <span>
                    {repository.name}
                    <small>
                      {repository.defaultBranch} · {repository.empty ? 'empty' : 'hosted'}
                    </small>
                  </span>
                </div>
              ))}
              {loadedOrganization && !w.busy && !w.repositories.length && (
                <p className="connection-hint">No repositories loaded.</p>
              )}
              {w.nextPageToken && (
                <Button
                  size="sm"
                  variant="ghost"
                  isDisabled={w.busy}
                  onPress={() => void w.list(organizationId, true)}
                >
                  Load more
                </Button>
              )}
            </nav>
          )}
          <form
            className="connection-form"
            onSubmit={(event) => {
              event.preventDefault()
              void w.create(organizationId, repositoryName)
            }}
          >
            <fieldset disabled={w.busy || !organizationId}>
              <label>
                New repository
                <input
                  value={repositoryName}
                  onChange={(event) => setRepositoryName(event.target.value)}
                  placeholder="my-project"
                  pattern="[A-Za-z0-9_-][A-Za-z0-9_.-]*"
                  required
                />
              </label>
              <Button fullWidth type="submit" size="sm" variant="ghost">
                Create hosted repository
              </Button>
            </fieldset>
          </form>
          <form
            className="connection-form"
            onSubmit={(event) => {
              event.preventDefault()
              if (!w.dirty || confirm('Discard your unsaved draft and load the server document?')) {
                void w.open(documentId, workspaceId)
                onOpen()
              }
            }}
          >
            <fieldset disabled={w.busy}>
              <legend>Live document</legend>
              <label>
                Workspace ID
                <input
                  value={workspaceId}
                  onChange={(event) => setWorkspaceId(event.target.value)}
                  placeholder="shared-workspace"
                  required
                />
              </label>
              <label>
                Document ID
                <input
                  value={documentId}
                  onChange={(event) => setDocumentId(event.target.value)}
                  placeholder="shared-document"
                  required
                />
              </label>
              <Button fullWidth type="submit" variant="secondary">
                <FileCode aria-hidden />
                Open document
              </Button>
            </fieldset>
            <p className="connection-hint">
              Use the same IDs on another desktop to collaborate. New document IDs start empty. Git
              file-tree APIs are not available yet.
            </p>
          </form>
        </div>
      )}
      {w.error && (
        <p className="connection-error" role="alert">
          {w.error}
        </p>
      )}
      {w.remoteChanged && (
        <p className="connection-notice" role="status">
          Remote changes arrived. Your draft is preserved. Copy it before reopening the latest
          document.
        </p>
      )}
      <div className="connection-footer">
        <span className="sync-dot" data-live={w.live} />
        {w.live
          ? 'Document stream connected'
          : w.user
            ? 'Signed in · no live stream'
            : 'Not connected'}
      </div>
    </aside>
  )
}
