// Renderer-safe DTOs only. Tokens and raw gRPC frames never cross the bridge.
export interface User {
  userId: string
  displayName: string
  email: string
}

export interface LoginInput {
  endpoint: string
  email: string
  password: string
  displayName?: string
  register: boolean
}

export interface Repository {
  repositoryId: string
  name: string
  defaultBranch: string
  empty: boolean
}

export interface DocumentView {
  documentId: string
  workspaceId: string
  text: string
  version: string
}

export type DocumentEvent =
  | { kind: 'snapshot'; document: DocumentView }
  | { kind: 'closed'; message: string }

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

export interface DesktopAPI {
  session(): Promise<Result<{ endpoint: string; user: User | null }>>
  login(input: LoginInput): Promise<Result<User>>
  logout(): Promise<Result<void>>
  listRepositories(input: {
    organizationId: string
    pageToken?: string
  }): Promise<Result<{ repositories: Repository[]; nextPageToken: string }>>
  createRepository(input: { organizationId: string; name: string }): Promise<Result<Repository>>
  openDocument(input: { documentId: string; workspaceId: string }): Promise<Result<DocumentView>>
  saveDocument(input: { text: string; version: string }): Promise<Result<DocumentView>>
  closeDocument(): Promise<Result<void>>
  onDocument(callback: (event: DocumentEvent) => void): () => void
}

declare global {
  interface Window {
    desktop?: DesktopAPI
  }
}
