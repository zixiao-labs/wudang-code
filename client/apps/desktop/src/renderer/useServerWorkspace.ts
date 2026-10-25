import { useEffect, useState } from 'react'
import type { DocumentView, LoginInput, Repository, Result, User } from '../shared/desktop'

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error)
  return result.value
}

interface State {
  user: User | null
  endpoint: string
  document: DocumentView | null
  draft: string
  live: boolean
  remoteChanged: boolean
  busy: boolean
  error: string
  repositories: Repository[]
  nextPageToken: string
}

export function useServerWorkspace() {
  const [state, setState] = useState<State>({
    user: null,
    endpoint: 'http://127.0.0.1:50051',
    document: null,
    draft: '',
    live: false,
    remoteChanged: false,
    busy: false,
    error: '',
    repositories: [],
    nextPageToken: '',
  })
  useEffect(() => {
    const api = window.desktop
    if (!api) return
    let active = true
    void api
      .session()
      .then((result) => {
        const session = unwrap(result)
        if (active) setState((current) => ({ ...current, ...session }))
      })
      .catch((error: Error) => {
        if (active) setState((current) => ({ ...current, error: error.message }))
      })
    const unsubscribe = api.onDocument((event) => {
      setState((current) => {
        if (event.kind === 'closed') return { ...current, live: false, error: event.message }
        if (
          !current.document ||
          event.document.documentId !== current.document.documentId ||
          event.document.version === current.document.version
        )
          return current
        if (current.draft !== current.document.text) return { ...current, remoteChanged: true }
        return { ...current, document: event.document, draft: event.document.text }
      })
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  async function run(action: (api: NonNullable<Window['desktop']>) => Promise<void>) {
    if (!window.desktop) return false
    setState((current) => ({ ...current, busy: true, error: '' }))
    try {
      await action(window.desktop)
      return true
    } catch (error) {
      setState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : 'Request failed.',
      }))
      return false
    } finally {
      setState((current) => ({ ...current, busy: false }))
    }
  }

  return {
    ...state,
    available: Boolean(window.desktop),
    dirty: Boolean(state.document && state.draft !== state.document.text),
    edit: (draft: string) => setState((current) => ({ ...current, draft })),
    login: (input: LoginInput) =>
      run(async (api) => {
        const user = unwrap(await api.login(input))
        setState((current) => ({ ...current, user, endpoint: input.endpoint }))
      }),
    logout: () =>
      run(async (api) => {
        try {
          unwrap(await api.logout())
        } finally {
          setState((current) => ({
            ...current,
            user: null,
            document: null,
            draft: '',
            live: false,
            remoteChanged: false,
            repositories: [],
            nextPageToken: '',
          }))
        }
      }),
    list: (organizationId: string, more = false) =>
      run(async (api) => {
        const result = unwrap(
          await api.listRepositories({
            organizationId,
            pageToken: more ? state.nextPageToken : '',
          }),
        )
        setState((current) => ({
          ...current,
          repositories: more
            ? [...current.repositories, ...result.repositories]
            : result.repositories,
          nextPageToken: result.nextPageToken,
        }))
      }),
    create: (organizationId: string, name: string) =>
      run(async (api) => {
        const repository = unwrap(await api.createRepository({ organizationId, name }))
        setState((current) => ({ ...current, repositories: [...current.repositories, repository] }))
      }),
    open: (documentId: string, workspaceId: string) =>
      run(async (api) => {
        const document = unwrap(await api.openDocument({ documentId, workspaceId }))
        setState((current) => ({
          ...current,
          document,
          draft: document.text,
          live: true,
          remoteChanged: false,
        }))
      }),
    save: () =>
      run(async (api) => {
        if (!state.document) return
        const document = unwrap(
          await api.saveDocument({ text: state.draft, version: state.document.version }),
        )
        setState((current) => ({
          ...current,
          document,
          draft: document.text,
          remoteChanged: false,
        }))
      }),
  }
}

export type ServerWorkspace = ReturnType<typeof useServerWorkspace>
