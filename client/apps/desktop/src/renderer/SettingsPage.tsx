import { Check, Display, Folder, Globe, Moon, Person, Sun } from '@gravity-ui/icons'
import { Button } from '@heroui/react/button'
import { useState, type FormEvent } from 'react'
import type { ServerWorkspace } from './useServerWorkspace'

export type SettingsSection = 'account' | 'workspace' | 'appearance'
export type Theme = 'light' | 'dark'

const sections = [
  { id: 'account', label: 'Account', icon: Person },
  { id: 'workspace', label: 'Workspace', icon: Folder },
  { id: 'appearance', label: 'Appearance', icon: Display },
] as const

export function SettingsPage({
  workspace,
  section,
  onSectionChange,
  theme,
  onThemeChange,
}: {
  workspace: ServerWorkspace
  section: SettingsSection
  onSectionChange: (section: SettingsSection) => void
  theme: Theme
  onThemeChange: (theme: Theme) => void
}) {
  return (
    <section className="settings-page" aria-label="Settings">
      <nav className="settings-navigation" aria-label="Settings categories">
        <h1>Settings</h1>
        {sections.map(({ id, label, icon: Icon }) => (
          <Button
            key={id}
            className="sidebar-row"
            variant="ghost"
            aria-current={section === id ? 'page' : undefined}
            onPress={() => onSectionChange(id)}
          >
            <Icon aria-hidden />
            {label}
          </Button>
        ))}
        <p>Make this space yours.</p>
      </nav>
      <div className="settings-scroll">
        <div className="settings-content">
          {section === 'account' ? (
            <AccountSettings workspace={workspace} />
          ) : section === 'workspace' ? (
            <RepositorySettings
              workspace={workspace}
              onAccount={() => onSectionChange('account')}
            />
          ) : (
            <>
              <header className="settings-heading">
                <h2>Appearance</h2>
                <p>A familiar space, in your preferred light.</p>
              </header>
              <section className="settings-group">
                <h3>Theme</h3>
                <p className="field-hint">Choose how Wudang looks on this device.</p>
                <div className="theme-options" role="group" aria-label="Color theme">
                  {(['light', 'dark'] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      className="theme-option"
                      aria-pressed={theme === value}
                      onClick={() => onThemeChange(value)}
                    >
                      <span className={`theme-sample ${value}`} aria-hidden>
                        <span />
                        <span>
                          <i />
                          <i />
                          <i />
                        </span>
                      </span>
                      <span>
                        {value === 'light' ? <Sun aria-hidden /> : <Moon aria-hidden />}
                        {value === 'light' ? 'Light' : 'Dark'}
                        {theme === value && <Check className="theme-check" aria-hidden />}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
              <div className="settings-row">
                <span>
                  <strong>Editor typography</strong>
                  <small>IBM Plex Mono · 13 px</small>
                </span>
                <code>Aa Bb 012</code>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  )
}

function AccountSettings({ workspace: w }: { workspace: ServerWorkspace }) {
  const [register, setRegister] = useState(false)

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const password = event.currentTarget.elements.namedItem('password') as HTMLInputElement
    const input = {
      endpoint: String(data.get('endpoint')).trim(),
      email: String(data.get('email')).trim(),
      password: password.value,
      displayName: String(data.get('displayName') ?? '').trim(),
      register,
    }
    password.value = ''
    await w.login(input)
  }

  return (
    <>
      <header className="settings-heading">
        <h2>Account</h2>
        <p>Your identity and connection, in one place.</p>
      </header>
      {!w.available && (
        <p className="form-notice" role="status">
          You’re viewing a browser preview. Open the desktop app to sign in and connect to your
          server.
        </p>
      )}
      {w.user ? (
        <>
          <section className="settings-group">
            <div className="profile-summary">
              <span className="account-avatar">{w.user.displayName.slice(0, 1).toUpperCase()}</span>
              <span>
                <strong>{w.user.displayName}</strong>
                <small>{w.user.email}</small>
              </span>
              <span className="connected-label">
                <Check aria-hidden />
                Signed in
              </span>
            </div>
          </section>
          <section className="settings-group">
            <h3>Connected server</h3>
            <div className="server-address">
              <Globe aria-hidden />
              <code>{w.endpoint}</code>
            </div>
            <p className="field-hint">To switch servers or accounts, sign out first.</p>
          </section>
          <div className="settings-row">
            <span>
              <strong>Sign out of Wudang</strong>
              <small>You’ll need to sign in again next time.</small>
            </span>
            <Button
              variant="outline"
              isDisabled={w.busy}
              onPress={() => {
                if (!w.dirty || confirm('Discard your unsaved draft and sign out?')) void w.logout()
              }}
            >
              Sign out
            </Button>
          </div>
        </>
      ) : (
        <form className="settings-form" onSubmit={(event) => void login(event)}>
          <fieldset disabled={!w.available || w.busy}>
            <section className="settings-group">
              <h3>{register ? 'Create your account' : 'Sign in to Wudang'}</h3>
              <label>
                Email
                <input
                  name="email"
                  type="email"
                  autoComplete="username"
                  placeholder="you@example.com"
                  required
                />
              </label>
              {register && (
                <label>
                  Display name
                  <input name="displayName" autoComplete="name" placeholder="Your name" required />
                </label>
              )}
              <label>
                Password
                <input
                  name="password"
                  type="password"
                  autoComplete={register ? 'new-password' : 'current-password'}
                  minLength={register ? 12 : 1}
                  placeholder={register ? 'At least 12 characters' : 'Your password'}
                  required
                />
              </label>
              <div className="account-actions">
                <Button type="submit" isPending={w.busy}>
                  {w.busy ? 'Connecting…' : register ? 'Create account' : 'Sign in'}
                </Button>
                <Button variant="ghost" onPress={() => setRegister((value) => !value)}>
                  {register ? 'Back to sign in' : 'Create a local account'}
                </Button>
              </div>
              {register && (
                <p className="field-hint">
                  Account creation must be enabled by your server administrator.
                </p>
              )}
            </section>
            <section className="settings-group">
              <h3>Server connection</h3>
              <p className="field-hint">Use your team’s server, or a local instance.</p>
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
            </section>
          </fieldset>
        </form>
      )}
      <p className="settings-footnote">
        Credentials stay in the desktop app and are cleared when it closes. Remote connections are
        encrypted.
      </p>
    </>
  )
}

function RepositorySettings({
  workspace: w,
  onAccount,
}: {
  workspace: ServerWorkspace
  onAccount: () => void
}) {
  const [organizationId, setOrganizationId] = useState('')
  const [repositoryName, setRepositoryName] = useState('')
  const [loadedOrganization, setLoadedOrganization] = useState('')
  const currentOrganization = loadedOrganization === organizationId.trim()

  return (
    <>
      <header className="settings-heading">
        <h2>Workspace</h2>
        <p>A home for your projects and shared documents.</p>
      </header>
      {!w.user ? (
        <div className="settings-group">
          <h3>Connect your workspace</h3>
          <p className="field-hint">Sign in to browse and create hosted repositories.</p>
          <Button variant="secondary" onPress={onAccount}>
            Go to account settings
          </Button>
        </div>
      ) : (
        <>
          <form
            className="settings-form"
            onSubmit={(event) => {
              event.preventDefault()
              void w.list(organizationId.trim()).then((success) => {
                if (success) setLoadedOrganization(organizationId.trim())
              })
            }}
          >
            <fieldset className="settings-group" disabled={w.busy}>
              <h3>Organization</h3>
              <label>
                Organization ID
                <input
                  value={organizationId}
                  onChange={(event) => setOrganizationId(event.target.value)}
                  placeholder="Organization UUID"
                  required
                  pattern=".*\S.*"
                />
              </label>
              <Button type="submit" variant="secondary" isPending={w.busy}>
                Load repositories
              </Button>
            </fieldset>
          </form>
          {loadedOrganization && currentOrganization && (
            <section className="settings-group">
              <h3>Repositories</h3>
              {w.repositories.map((repository) => (
                <div className="settings-row" key={repository.repositoryId}>
                  <span>
                    <strong>{repository.name}</strong>
                    <small>
                      {repository.defaultBranch} ·{' '}
                      {repository.empty ? 'Empty repository' : 'Hosted repository'}
                    </small>
                  </span>
                  <Folder aria-hidden />
                </div>
              ))}
              {!w.repositories.length && (
                <p className="field-hint">No repositories yet. Create your first one below.</p>
              )}
              {w.nextPageToken && (
                <Button
                  variant="ghost"
                  isDisabled={w.busy}
                  onPress={() => void w.list(organizationId.trim(), true)}
                >
                  Load more
                </Button>
              )}
            </section>
          )}
          <form
            className="settings-form"
            onSubmit={(event) => {
              event.preventDefault()
              void w.create(organizationId.trim(), repositoryName.trim())
            }}
          >
            <fieldset
              className="settings-group"
              disabled={w.busy || !loadedOrganization || !currentOrganization}
            >
              <h3>New repository</h3>
              <label>
                Repository name
                <input
                  value={repositoryName}
                  onChange={(event) => setRepositoryName(event.target.value)}
                  placeholder="my-project"
                  pattern="[A-Za-z0-9_\-][A-Za-z0-9_.\-]*"
                  required
                />
              </label>
              <Button type="submit" variant="secondary">
                Create hosted repository
              </Button>
            </fieldset>
          </form>
          <p className="settings-footnote">
            Hosted repositories are listed here. File browsing and Git checkout are not available
            yet; open shared documents separately from the workspace.
          </p>
        </>
      )}
    </>
  )
}
