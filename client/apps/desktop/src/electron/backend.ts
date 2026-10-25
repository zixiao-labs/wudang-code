import {
  Client,
  credentials,
  Metadata,
  type ClientDuplexStream,
  type MethodDefinition,
} from '@grpc/grpc-js'
import { fromJSON, type ServiceDefinition } from '@grpc/proto-loader'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import schema from './protocol'
import type { DocumentEvent, DocumentView, LoginInput, Repository, User } from '../shared/desktop'

const protocol = fromJSON(schema as Parameters<typeof fromJSON>[0], {
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
})
const auth = 'wudang.auth.v1.AuthService'
const repositories = 'wudang.repository.v1.RepositoryService'
const collaboration = 'wudang.collab.v1.CollaborationService'

interface Session {
  accessToken: string
  refreshToken: string
  accessTokenExpiresAt: { seconds: string }
  user: User
}

interface Version {
  digest: string
  base: Record<string, string>
  frontier: { replicaId: string; sequence: string }[]
}

interface Snapshot {
  document: { documentId: string; workspaceId: string }
  version: Version
  renderedText: string
}

interface ServerFrame {
  ready?: { snapshot: Snapshot }
  delta?: unknown
  deltaAck?: { deltaId: { sequence: string } }
  resyncRequired?: { message: string }
  error?: { message: string }
}

export function parseEndpoint(endpoint: string) {
  const url = new URL(endpoint)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('Use a gRPC origin, e.g. http://127.0.0.1:50051 or https://server:50051.')
  }
  // Do not trust DNS names for plaintext credentials, including "localhost".
  if (url.protocol === 'http:' && !['127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error(
      'Remote servers require HTTPS. Plaintext is allowed only on 127.0.0.1 or [::1].',
    )
  }
  return { endpoint: url.origin, target: url.host, tls: url.protocol === 'https:' }
}

function method(service: string, name: string) {
  const definition = (protocol[service] as ServiceDefinition)[name]
  if (!definition) throw new Error(`Unknown RPC ${service}/${name}`)
  return definition as MethodDefinition<object, object>
}

function required(value: unknown, name: string, max = 256): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`${name} is required (maximum ${max} characters).`)
  }
}

function view(snapshot: Snapshot): DocumentView {
  return {
    documentId: snapshot.document.documentId,
    workspaceId: snapshot.document.workspaceId,
    text: snapshot.renderedText,
    version: snapshot.version.digest,
  }
}

export function replacementEdit(previous: string, next: string) {
  const before = Array.from(previous)
  const after = Array.from(next)
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let oldEnd = before.length
  let newEnd = after.length
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd--
    newEnd--
  }
  return {
    startUtf8: String(Buffer.byteLength(before.slice(0, start).join(''))),
    endUtf8: String(Buffer.byteLength(before.slice(0, oldEnd).join(''))),
    insertedText: after.slice(start, newEnd).join(''),
  }
}

function publicUser(user: User): User {
  return { userId: user.userId, displayName: user.displayName, email: user.email }
}

export class Backend {
  private client: Client | null = null
  private sessionValue: Session | null = null
  private refresh: Promise<void> | null = null
  private endpoint = process.env.WUDANG_SERVER_URL ?? 'http://127.0.0.1:50051'
  private readonly deviceId = randomUUID()
  private document: {
    id: string
    workspaceId: string
    replicaId: string
    sequence: number
    stream: ClientDuplexStream<object, ServerFrame>
    snapshot?: Snapshot
    sync: Promise<void>
    saving: boolean
    pending?: { sequence: string; resolve: () => void; reject: (error: Error) => void }
  } | null = null
  private authenticating = false

  constructor(private readonly emit: (event: DocumentEvent) => void = () => {}) {}

  session() {
    return {
      endpoint: this.endpoint,
      user: this.sessionValue ? publicUser(this.sessionValue.user) : null,
    }
  }

  private rpc<T>(service: string, name: string, request: object, token?: string): Promise<T> {
    if (!this.client) return Promise.reject(new Error('Connect to a server first.'))
    const definition = method(service, name)
    const metadata = new Metadata()
    if (token) metadata.set('authorization', `Bearer ${token}`)
    return new Promise((resolve, reject) => {
      this.client!.makeUnaryRequest(
        definition.path,
        definition.requestSerialize,
        definition.responseDeserialize,
        request,
        metadata,
        { deadline: Date.now() + 15_000 },
        (error, response) => (error ? reject(error) : resolve(response as T)),
      )
    })
  }

  private clientInfo() {
    return {
      deviceId: this.deviceId,
      deviceName: 'Wudang desktop',
      appVersion: '1.0.0',
      platform: process.platform,
    }
  }

  async login(input: LoginInput): Promise<User> {
    if (this.authenticating || this.sessionValue)
      throw new Error('Sign out before connecting again.')
    required(input.endpoint, 'Server address', 2048)
    required(input.email, 'Email')
    required(input.password, 'Password', 1024)
    if (input.register) required(input.displayName, 'Display name')
    const endpoint = parseEndpoint(input.endpoint)
    this.authenticating = true
    this.client?.close()
    try {
      this.client = new Client(
        endpoint.target,
        endpoint.tls
          ? credentials.createSsl(
              process.env.WUDANG_TLS_CA_PATH
                ? readFileSync(process.env.WUDANG_TLS_CA_PATH)
                : undefined,
            )
          : credentials.createInsecure(),
      )
      this.sessionValue = await this.rpc<Session>(
        auth,
        input.register ? 'RegisterLocal' : 'LoginLocal',
        {
          requestId: randomUUID(),
          email: input.email,
          password: input.password,
          displayName: input.displayName,
          client: this.clientInfo(),
        },
      )
      this.endpoint = endpoint.endpoint
      return publicUser(this.sessionValue.user)
    } catch (error) {
      this.client?.close()
      this.client = null
      throw error
    } finally {
      this.authenticating = false
    }
  }

  private async token() {
    if (!this.sessionValue) throw new Error('Sign in first.')
    if (Number(this.sessionValue.accessTokenExpiresAt.seconds) * 1000 < Date.now() + 30_000) {
      // Refresh tokens rotate: concurrent calls MUST share a single rotation.
      this.refresh ??= this.rpc<Session>(auth, 'RefreshSession', {
        requestId: randomUUID(),
        refreshToken: this.sessionValue.refreshToken,
        client: this.clientInfo(),
      })
        .then((session) => {
          this.sessionValue = session
        })
        .finally(() => {
          this.refresh = null
        })
      await this.refresh
    }
    return this.sessionValue.accessToken
  }

  async listRepositories(input: { organizationId: string; pageToken?: string }) {
    required(input.organizationId, 'Organization ID')
    return this.rpc<{ repositories: Repository[]; nextPageToken: string }>(
      repositories,
      'ListRepositories',
      { organizationId: input.organizationId, pageSize: 100, pageToken: input.pageToken ?? '' },
      await this.token(),
    )
  }

  async createRepository(input: { organizationId: string; name: string }) {
    required(input.organizationId, 'Organization ID')
    required(input.name, 'Repository name', 100)
    return this.rpc<Repository>(
      repositories,
      'CreateHostedRepository',
      {
        requestId: randomUUID(),
        organizationId: input.organizationId,
        name: input.name,
        defaultBranch: 'main',
      },
      await this.token(),
    )
  }

  async openDocument(input: { documentId: string; workspaceId: string }): Promise<DocumentView> {
    required(input.documentId, 'Document ID')
    required(input.workspaceId, 'Workspace ID')
    const token = await this.token()
    this.closeDocument()
    const definition = method(collaboration, 'SyncDocument')
    const metadata = new Metadata()
    metadata.set('authorization', `Bearer ${token}`)
    const stream = this.client!.makeBidiStreamRequest(
      definition.path,
      definition.requestSerialize,
      definition.responseDeserialize,
      metadata,
    ) as ClientDuplexStream<object, ServerFrame>
    const document = {
      id: input.documentId,
      workspaceId: input.workspaceId,
      // A fresh replica namespace per open avoids sequence reuse after restarts.
      replicaId: randomUUID(),
      sequence: 0,
      stream,
      sync: Promise.resolve(),
      saving: false,
    } as NonNullable<Backend['document']>
    this.document = document
    return new Promise((resolve, reject) => {
      let opened = false
      const timer = setTimeout(() => fail(new Error('Timed out opening the document.')), 15_000)
      const fail = (error: Error) => {
        clearTimeout(timer)
        document.pending?.reject(error)
        document.pending = undefined
        if (!opened) reject(error)
        if (this.document === document) {
          this.document = null
          stream.cancel()
          this.emit({ kind: 'closed', message: error.message })
        }
      }
      stream.on('data', (frame: ServerFrame) => {
        if (this.document !== document) return
        if (frame.ready) {
          clearTimeout(timer)
          document.snapshot = frame.ready.snapshot
          opened = true
          resolve(view(frame.ready.snapshot))
        } else if (
          frame.deltaAck &&
          document.pending?.sequence === frame.deltaAck.deltaId.sequence
        ) {
          document.pending.resolve()
          document.pending = undefined
        } else if (frame.delta) {
          // The server owns CRDT materialization. Never apply a remote UTF-8 edit
          // directly to a renderer buffer that may have a different causal head.
          document.sync = document.sync
            .then(async () =>
              this.rpc<Snapshot>(
                collaboration,
                'GetDocumentSnapshot',
                { documentId: document.id },
                await this.token(),
              ),
            )
            .then((snapshot) => {
              if (this.document !== document) return
              document.snapshot = snapshot
              this.emit({ kind: 'snapshot', document: view(snapshot) })
            })
            .catch(fail)
        } else if (frame.error || frame.resyncRequired) {
          fail(new Error(frame.error?.message ?? frame.resyncRequired!.message))
        }
      })
      stream.on('error', fail)
      stream.on('end', () => fail(new Error('Document stream disconnected. Reopen to reconnect.')))
      stream.write({
        open: {
          documentId: input.documentId,
          workspaceId: input.workspaceId,
          replicaId: document.replicaId,
          deviceId: this.deviceId,
        },
      })
    })
  }

  async saveDocument(input: { text: string; version: string }): Promise<DocumentView> {
    if (typeof input.text !== 'string' || Buffer.byteLength(input.text) > 1_000_000) {
      throw new Error('Documents must be UTF-8 text smaller than 1 MB.')
    }
    const document = this.document
    if (!document?.snapshot) throw new Error('Open a document first.')
    if (document.saving) throw new Error('A save is already in progress.')
    document.saving = true
    let submitted = false
    try {
      await document.sync
      if (this.document !== document) throw new Error('Document is disconnected.')
      // Save relative to the exact snapshot the editor opened, not a newer remote head.
      const base = document.snapshot
      if (input.version !== base.version.digest)
        throw new Error('Document version changed. Reopen before saving.')
      if (input.text === base.renderedText) return view(base)
      const sequence = String(++document.sequence)
      submitted = true
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              'Save acknowledgement timed out. Reopen to check server state before retrying.',
            ),
          )
          this.closeDocument()
          this.emit({
            kind: 'closed',
            message: 'Save status unknown. Your draft is kept; reopen before retrying.',
          })
        }, 15_000)
        document.pending = {
          sequence,
          resolve: () => {
            clearTimeout(timer)
            resolve()
          },
          reject: (error) => {
            clearTimeout(timer)
            reject(error)
          },
        }
        document.stream.write({
          delta: {
            documentId: document.id,
            deltaId: { replicaId: document.replicaId, sequence },
            basedOn: base.version,
            requestId: randomUUID(),
            edits: [replacementEdit(base.renderedText, input.text)],
          },
        })
      })
      document.sync = document.sync.then(async () => {
        const snapshot = await this.rpc<Snapshot>(
          collaboration,
          'GetDocumentSnapshot',
          { documentId: document.id },
          await this.token(),
        )
        if (this.document !== document) throw new Error('Document was closed during save.')
        document.snapshot = snapshot
      })
      await document.sync
      return view(document.snapshot)
    } catch (error) {
      if (submitted && this.document === document) {
        this.closeDocument()
        this.emit({
          kind: 'closed',
          message: 'Could not confirm the saved document. Draft kept; reopen before retrying.',
        })
      }
      throw error
    } finally {
      document.saving = false
    }
  }

  closeDocument() {
    const document = this.document
    this.document = null
    document?.pending?.reject(new Error('Document closed.'))
    document?.stream.cancel()
  }

  async logout() {
    try {
      if (this.refresh) await this.refresh
      if (this.sessionValue) {
        await this.rpc(auth, 'RevokeSession', {
          requestId: randomUUID(),
          refreshToken: this.sessionValue.refreshToken,
        })
      }
    } finally {
      this.dispose()
    }
  }

  dispose() {
    this.closeDocument()
    this.client?.close()
    this.client = null
    this.sessionValue = null
  }
}
