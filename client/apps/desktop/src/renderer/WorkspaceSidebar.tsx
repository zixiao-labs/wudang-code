import { ChevronDown, Code, Comment, FileCode, Folder, Gear, Person, Plus } from '@gravity-ui/icons'
import { Button } from '@heroui/react/button'
import type { SettingsSection } from './SettingsPage'
import type { ServerWorkspace } from './useServerWorkspace'

export function WorkspaceSidebar({
  workspace: w,
  activeView,
  onNavigate,
  onSettings,
  onOpenDocument,
}: {
  workspace: ServerWorkspace
  activeView: 'edit' | 'agent' | 'settings'
  onNavigate: (view: 'edit' | 'agent') => void
  onSettings: (section?: SettingsSection) => void
  onOpenDocument: () => void
}) {
  return (
    <aside className="project-sidebar" aria-label="Workspace sidebar">
      <nav className="sidebar-navigation" aria-label="Workspace view">
        <Button
          className="sidebar-row"
          variant="ghost"
          aria-current={activeView === 'edit' ? 'page' : undefined}
          onPress={() => onNavigate('edit')}
        >
          <Code aria-hidden />
          Editor
        </Button>
        <Button
          className="sidebar-row"
          variant="ghost"
          aria-current={activeView === 'agent' ? 'page' : undefined}
          onPress={() => onNavigate('agent')}
        >
          <Comment aria-hidden />
          Threads<span className="row-meta">Preview</span>
        </Button>
      </nav>
      <div className="sidebar-scroll">
        <div className="sidebar-section-heading">
          <span>Projects</span>
          <Button
            aria-label="Manage projects"
            className="icon-button"
            isIconOnly
            size="sm"
            variant="ghost"
            onPress={() => onSettings('workspace')}
          >
            <Plus aria-hidden />
          </Button>
        </div>
        {w.repositories.length ? (
          <ul className="repository-list" aria-label="Server repositories">
            {w.repositories.map((repository) => (
              <li
                key={repository.repositoryId}
                title={`${repository.name} · ${repository.defaultBranch}`}
              >
                <Folder aria-hidden />
                <span>{repository.name}</span>
                <small>{repository.defaultBranch}</small>
              </li>
            ))}
          </ul>
        ) : (
          <p className="sidebar-hint">
            {w.user ? (
              'No projects loaded. Manage your repositories in Settings.'
            ) : (
              <>
                Your projects, all in one place.
                <br />
                Add a server in Settings to begin.
              </>
            )}
          </p>
        )}
        <div className="sidebar-section-heading documents-heading">
          <span>Open documents</span>
          <Button
            aria-label="Open another document"
            className="icon-button"
            isIconOnly
            size="sm"
            variant="ghost"
            onPress={onOpenDocument}
          >
            <Plus aria-hidden />
          </Button>
        </div>
        {w.document ? (
          <>
            <div className="workspace-tree-heading">
              <ChevronDown aria-hidden />
              <Folder aria-hidden />
              <span>{w.document.workspaceId}</span>
            </div>
            <Button
              className="sidebar-row document-row"
              variant="ghost"
              aria-current={activeView === 'edit' ? 'page' : undefined}
              onPress={() => onNavigate('edit')}
            >
              <FileCode aria-hidden />
              <span>{w.document.documentId}</span>
              {w.dirty && <span className="dirty-indicator" title="Unsaved changes" />}
            </Button>
          </>
        ) : (
          <p className="sidebar-hint">No documents open</p>
        )}
      </div>
      <Button className="sidebar-account" variant="ghost" onPress={() => onSettings()}>
        <span className="account-avatar">
          {w.user ? w.user.displayName.slice(0, 1).toUpperCase() : <Person aria-hidden />}
        </span>
        <span>
          {w.user?.displayName ?? 'Personal workspace'}
          <small>{w.user ? 'Account & settings' : 'Set up your account'}</small>
        </span>
        <Gear aria-hidden />
      </Button>
    </aside>
  )
}
