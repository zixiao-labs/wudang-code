import { afterAll, beforeAll, expect, test } from '@lightning-js/lightning'
import { Server, ServerCredentials, status } from '@grpc/grpc-js'
import { fromJSON, type ServiceDefinition } from '@grpc/proto-loader'
import schema from '../src/electron/protocol'
import { Backend, parseEndpoint, replacementEdit } from '../src/electron/backend'

test('only literal loopback addresses may carry plaintext credentials', () => {
  expect(parseEndpoint('http://127.0.0.1:50051').target).toBe('127.0.0.1:50051')
  expect(parseEndpoint('http://[::1]:50051').tls).toBe(false)
  expect(parseEndpoint('https://wudang.example:443').tls).toBe(true)
  for (const endpoint of [
    'http://localhost:50051',
    'http://192.168.1.4:50051',
    'http://127.0.0.1.example:50051',
    'https://user:password@example.com',
    'https://example.com/rpc',
    'https://example.com?token=secret',
    'ftp://example.com',
    'not a URL',
  ])
    expect(() => parseEndpoint(endpoint)).toThrow()
})

test('replacement ranges are UTF-8 boundaries, including non-BMP code points', () => {
  for (const [before, after] of [
    ['', '武当'],
    ['hello 武当 👩🏽‍💻', 'hello 武当 🚀'],
    ['a😀z', 'a😁z'],
    ['武当', ''],
    ['unchanged', 'unchanged'],
    ['prefix\nmiddle\nsuffix', 'prefix\nnew middle\nsuffix'],
  ]) {
    const edit = replacementEdit(before, after)
    const bytes = Buffer.from(before)
    const result = Buffer.concat([
      bytes.subarray(0, Number(edit.startUtf8)),
      Buffer.from(edit.insertedText),
      bytes.subarray(Number(edit.endUtf8)),
    ]).toString('utf8')
    expect(result).toBe(after)
    expect(result).not.toContain('\uFFFD')
  }
})

const protocol = fromJSON(schema as Parameters<typeof fromJSON>[0], {
  longs: String,
  defaults: true,
})
const server = new Server()
let endpoint: string
let rotations = 0
let receivedAuthorization = ''
const user = { userId: 'user-test', displayName: 'Test', email: 'test@example.invalid' }
const session = (expires: number) => ({
  user,
  accessToken: 'private-access',
  refreshToken: 'private-refresh',
  accessTokenExpiresAt: { seconds: String(expires) },
})

beforeAll(async () => {
  server.addService(protocol['wudang.auth.v1.AuthService'] as ServiceDefinition, {
    loginLocal: (_call: unknown, callback: Function) => callback(null, session(0)),
    refreshSession: (_call: unknown, callback: Function) => {
      rotations++
      setTimeout(() => callback(null, session(Math.floor(Date.now() / 1000) + 3600)), 20)
    },
    revokeSession: (_call: unknown, callback: Function) => callback(null, { revoked: true }),
  })
  server.addService(protocol['wudang.repository.v1.RepositoryService'] as ServiceDefinition, {
    listRepositories: (call: { metadata: { get(key: string): unknown[] } }, callback: Function) => {
      receivedAuthorization = String(call.metadata.get('authorization')[0])
      callback(null, { repositories: [], nextPageToken: '' })
    },
    createHostedRepository: (_call: unknown, callback: Function) =>
      callback({ code: status.PERMISSION_DENIED, details: 'Registration required' }),
  })
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', ServerCredentials.createInsecure(), (error, port) => {
      if (error) reject(error)
      else resolve(port)
    })
  })
  endpoint = `http://127.0.0.1:${port}`
})

afterAll(() => server.forceShutdown())

test('sessions stay private and parallel authenticated calls share one refresh', async () => {
  const backend = new Backend()
  try {
    expect(
      await backend.login({
        endpoint,
        email: user.email,
        password: 'test-password',
        register: false,
      }),
    ).toEqual(user)
    expect(JSON.stringify(backend.session())).not.toContain('private-')
    await Promise.all([
      backend.listRepositories({ organizationId: 'org' }),
      backend.listRepositories({ organizationId: 'org' }),
    ])
    expect(rotations).toBe(1)
    expect(receivedAuthorization).toBe('Bearer private-access')
    await expect(backend.createRepository({ organizationId: 'org', name: 'repo' })).rejects.toThrow(
      /Registration required/,
    )
    await backend.logout()
    expect(backend.session().user).toBe(null)
    await expect(backend.listRepositories({ organizationId: 'org' })).rejects.toThrow(
      /Sign in first/,
    )
  } finally {
    backend.dispose()
  }
})
