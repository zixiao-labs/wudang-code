import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { userInfo } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { _electron as electron } from 'playwright'
import { Backend } from '../src/electron/backend'
import type { DocumentEvent } from '../src/shared/desktop'

const serverRoot = fileURLToPath(new URL('../../../../server/', import.meta.url))

async function freePort() {
  const listener = createServer()
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
  const port = (listener.address() as { port: number }).port
  await new Promise<void>((resolve) => listener.close(() => resolve()))
  return port
}

async function until<T>(operation: () => T | Promise<T>, timeout = 15_000): Promise<T> {
  const deadline = Date.now() + timeout
  while (true) {
    try {
      const result = await operation()
      if (result) return result
    } catch (error) {
      if (Date.now() >= deadline) throw error
    }
    if (Date.now() >= deadline) throw new Error('Timed out waiting for integration state.')
    await delay(30)
  }
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
    child.kill('SIGTERM')
  })
}

test(
  'Electron IPC and two desktop hosts connect to Rust gRPC and recover persisted Unicode edits',
  { timeout: 90_000 },
  async () => {
    // All database/storage state is disposable and stays inside the ignored target directory.
    const directory = await mkdtemp(path.join(serverRoot, 'target/desktop-e2e-'))
    const pgPort = await freePort()
    const grpcPort = await freePort()
    const endpoint = `http://127.0.0.1:${grpcPort}`
    const pgData = path.join(directory, 'postgres')
    execFileSync('initdb', ['-D', pgData, '-A', 'trust', '--no-locale', '-E', 'UTF8'], {
      stdio: 'pipe',
    })
    const postgres = spawn(
      'postgres',
      ['-D', pgData, '-h', '127.0.0.1', '-p', String(pgPort), '-k', ''],
      { stdio: 'ignore' },
    )
    let daemon: ChildProcess | undefined
    const hosts: Backend[] = []
    let application: Awaited<ReturnType<typeof electron.launch>> | undefined
    try {
      await until(() => {
        execFileSync('pg_isready', ['-h', '127.0.0.1', '-p', String(pgPort)], { stdio: 'pipe' })
        return true
      })
      const environment = {
        ...process.env,
        WUDANG_DATABASE_URL: `postgresql://${encodeURIComponent(userInfo().username)}@127.0.0.1:${pgPort}/postgres`,
        WUDANG_LISTEN_ADDR: `127.0.0.1:${grpcPort}`,
        WUDANG_GIT_ROOT: path.join(directory, 'git'),
        WUDANG_BLOB_ROOT: path.join(directory, 'blobs'),
        WUDANG_JWT_SECRET_BASE64: randomBytes(32).toString('base64'),
        WUDANG_STORAGE_KEY_BASE64: randomBytes(32).toString('base64'),
        WUDANG_REFRESH_PEPPER_BASE64: randomBytes(32).toString('base64'),
        WUDANG_ALLOW_LOCAL_REGISTRATION: 'true',
        WUDANG_REQUIRE_ENCRYPTED_GIT_VOLUME: 'false',
        WUDANG_ACCESS_TTL_SECONDS: '2',
        WUDANG_TLS_CERT_PATH: '',
        WUDANG_TLS_KEY_PATH: '',
      }
      const start = () => {
        const child = spawn(path.join(serverRoot, 'target/debug/wudangd'), [], {
          env: environment,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        child.stderr.on('data', (data) => process.stderr.write(data))
        child.stdout.resume()
        return child
      }
      daemon = start()
      const events: DocumentEvent[] = []
      const first = new Backend()
      const second = new Backend((event) => events.push(event))
      hosts.push(first, second)
      const account = {
        endpoint,
        email: `desktop-${randomUUID()}@example.invalid`,
        password: randomBytes(24).toString('base64'),
        displayName: 'Desktop E2E',
        register: true,
      }
      await until(() => first.login(account))
      assert.equal(JSON.stringify(first.session()).includes('accessToken'), false)
      await second.login({ ...account, register: false })
      const organizationId = randomUUID()
      assert.deepEqual((await first.listRepositories({ organizationId })).repositories, [])
      const repository = await first.createRepository({ organizationId, name: 'desktop-e2e' })
      assert.equal(
        (await second.listRepositories({ organizationId })).repositories[0].repositoryId,
        repository.repositoryId,
      )
      const document = {
        documentId: `doc-${randomUUID()}`,
        workspaceId: `workspace-${randomUUID()}`,
      }
      const initial = await first.openDocument(document)
      await second.openDocument(document)
      const text = 'hello 武当 👩🏽‍💻\nexport const connected = true\n'
      const saved = await first.saveDocument({ text, version: initial.version })
      assert.equal(saved.text, text)
      const broadcast = await until(() =>
        events.find((event) => event.kind === 'snapshot' && event.document.text === text),
      )
      assert.ok(broadcast)
      assert.equal(broadcast.kind, 'snapshot')
      if (broadcast.kind !== 'snapshot') throw new Error('Expected broadcast snapshot')
      // Keep the stream open beyond access-token expiry; snapshot RPCs must refresh.
      await delay(2_100)
      await assert.rejects(
        second.saveDocument({ text: 'stale draft', version: initial.version }),
        /version changed/,
      )
      const next = await second.saveDocument({
        text: `${text}// second desktop\n`,
        version: broadcast.document.version,
      })
      assert.match(next.text, /second desktop/)
      hosts.forEach((host) => host.dispose())
      await stop(daemon)
      daemon = start()
      await until(() => first.login({ ...account, register: false }))
      assert.equal((await first.openDocument(document)).text, next.text)
      await first.logout()

      // Exercise the production bundle, sandboxed preload, IPC, forms and real editor.
      const electronEnv: Record<string, string> = { WUDANG_SERVER_URL: endpoint }
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && key !== 'WUDANG_SERVER_URL') electronEnv[key] = value
      }
      delete electronEnv.ELECTRON_RUN_AS_NODE
      application = await electron.launch({
        args: [
          fileURLToPath(new URL('../dist/main.mjs', import.meta.url)),
          `--user-data-dir=${path.join(directory, 'electron')}`,
        ],
        env: electronEnv,
      })
      const page = await application.firstWindow()
      await page.getByRole('heading', { name: 'Connect to Wudang' }).waitFor()
      if (process.env.WUDANG_E2E_SCREENSHOT_DIR) {
        await page.screenshot({
          path: path.join(process.env.WUDANG_E2E_SCREENSHOT_DIR, 'connect.png'),
          animations: 'disabled',
        })
      }
      await page.getByLabel('Email', { exact: true }).fill(account.email)
      await page.getByLabel('Password', { exact: true }).fill(account.password)
      await page.getByRole('button', { name: 'Sign in', exact: true }).click()
      await page.getByLabel('Workspace ID', { exact: true }).fill(document.workspaceId)
      await page.getByLabel('Document ID', { exact: true }).fill(document.documentId)
      await page.getByRole('button', { name: 'Open document', exact: true }).click()
      const editor = page.getByRole('textbox', {
        name: `${document.documentId} source editor`,
        exact: true,
      })
      await until(async () => (await editor.textContent())?.includes('second desktop'))
      await first.login({ ...account, register: false })
      const remoteBase = await first.openDocument(document)
      await editor.press('ControlOrMeta+End')
      await page.keyboard.insertText('// unsaved local draft')
      await first.saveDocument({
        text: `${remoteBase.text}// remote update\n`,
        version: remoteBase.version,
      })
      await page.getByRole('status').filter({ hasText: 'Remote changes arrived' }).waitFor()
      assert.match((await editor.textContent()) ?? '', /unsaved local draft/)
      assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true)
      page.once('dialog', (dialog) => void dialog.accept())
      await page.getByRole('button', { name: 'Open document', exact: true }).click()
      await until(async () => (await editor.textContent())?.includes('remote update'))
      await editor.press('ControlOrMeta+End')
      await editor.press('End')
      await page.keyboard.insertText('// saved through Electron')
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await until(async () =>
        (await page.locator('.status-ready').textContent())?.includes('Saved on server'),
      )
      await page.setViewportSize({ width: 1200, height: 800 })
      if (process.env.WUDANG_E2E_SCREENSHOT_DIR) {
        await page.locator('.connection-panel').evaluate((panel) => {
          panel.scrollTop = 0
        })
        if (await page.getByRole('button', { name: 'Switch to dark theme' }).count()) {
          await page.getByRole('button', { name: 'Switch to dark theme' }).click()
        }
        await page.screenshot({
          path: path.join(process.env.WUDANG_E2E_SCREENSHOT_DIR, 'connected-dark.png'),
          animations: 'disabled',
        })
        await page.getByRole('button', { name: 'Switch to light theme' }).click()
        await page.screenshot({
          path: path.join(process.env.WUDANG_E2E_SCREENSHOT_DIR, 'connected-light.png'),
          animations: 'disabled',
        })
      }
      first.closeDocument()
      assert.match((await first.openDocument(document)).text, /saved through Electron/)
      await first.logout()
      await editor.press('ControlOrMeta+End')
      await page.keyboard.insertText('// preserved on disconnect')
      await stop(daemon)
      await page.getByRole('status').filter({ hasText: 'Offline' }).waitFor()
      assert.match((await editor.textContent()) ?? '', /preserved on disconnect/)
      assert.equal(await editor.getAttribute('contenteditable'), 'false')
      page.once('dialog', (dialog) => void dialog.accept())
      await page.getByRole('button', { name: 'Sign out', exact: true }).click()
      await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor()
    } finally {
      await application?.close()
      hosts.forEach((host) => host.dispose())
      if (daemon) await stop(daemon)
      await stop(postgres)
      await rm(directory, { recursive: true, force: true })
    }
  },
)
