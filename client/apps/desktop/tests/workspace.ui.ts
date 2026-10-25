import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from '@lightning-js/lightning'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import type { DocumentEvent, DocumentView } from '../src/shared/desktop'

const renderer = path.resolve(fileURLToPath(new URL('../dist/renderer/', import.meta.url)))
const server = createServer(async (request, response) => {
  const resource = path.resolve(
    renderer,
    `.${new URL(request.url ?? '/', 'http://localhost').pathname}`,
  )
  if (resource !== renderer && !resource.startsWith(`${renderer}${path.sep}`)) {
    response.writeHead(403).end()
    return
  }
  try {
    const filename = resource === renderer ? path.join(renderer, 'index.html') : resource
    const mime: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.svg': 'image/svg+xml',
      '.woff2': 'font/woff2',
    }
    response.setHeader('Content-Type', mime[path.extname(filename)] ?? 'application/octet-stream')
    response.end(await readFile(filename))
  } catch {
    response.writeHead(404).end()
  }
})

let browser: Browser
let context: BrowserContext
let page: Page
let url: string
let pageErrors: string[]

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  browser = await chromium.launch()
})

afterAll(async () => {
  await browser?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(async () => {
  context = await browser.newContext({
    viewport: { width: 1200, height: 800 },
    colorScheme: 'light',
  })
  page = await context.newPage()
  page.setDefaultTimeout(5_000)
  pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.addInitScript(() => {
    const user = { userId: 'ui-user', displayName: 'Alex Chen', email: 'alex@example.invalid' }
    let document: DocumentView | null = null
    let version = 1
    // A renderer fixture only: the integration project exercises the real native bridge.
    window.desktop = {
      session: async () => ({
        ok: true,
        value: { user: null, endpoint: 'http://127.0.0.1:50051' },
      }),
      login: async (input) =>
        input.email.startsWith('fail')
          ? { ok: false, error: 'Unable to sign in. Check your credentials.' }
          : { ok: true, value: user },
      logout: async () => ({ ok: true, value: undefined }),
      listRepositories: async () => ({ ok: true, value: { repositories: [], nextPageToken: '' } }),
      createRepository: async ({ name }) => ({
        ok: true,
        value: { name, repositoryId: name, defaultBranch: 'main', empty: true },
      }),
      openDocument: async (input) => {
        if (input.documentId === 'missing-document')
          return { ok: false, error: 'This document could not be opened.' }
        if (input.documentId === 'pending-document') {
          await new Promise<void>((resolve) => {
            window.addEventListener('test-open-ready', () => resolve(), { once: true })
          })
        }
        document = {
          ...input,
          text: "export const greeting = 'Hello, 武当'\n",
          version: String(version++),
        }
        return { ok: true, value: document }
      },
      saveDocument: async ({ text }) => {
        if (!document) return { ok: false, error: 'No document open.' }
        document = { ...document, text, version: String(version++) }
        return { ok: true, value: document }
      },
      closeDocument: async () => ({ ok: true, value: undefined }),
      onDocument: (callback) => {
        const listener = (event: Event) => callback((event as CustomEvent<DocumentEvent>).detail)
        window.addEventListener('test-document', listener)
        return () => window.removeEventListener('test-document', listener)
      },
    }
  })
  await page.goto(url)
  await page
    .getByRole('region', { name: 'Welcome', exact: true })
    .waitFor()
    .catch(async (error) => {
      throw new Error(
        `${error.message}\nRenderer errors: ${pageErrors.join('; ')}\nBody: ${await page.locator('body').innerText()}`,
      )
    })
})

afterEach(async () => {
  await context?.close()
  expect(pageErrors).toEqual([])
})

async function signIn() {
  await page.getByRole('button', { name: 'Open settings', exact: true }).click()
  await page.getByLabel('Email', { exact: true }).fill('alex@example.invalid')
  await page.getByLabel('Password', { exact: true }).fill('ui-test-password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Close settings', exact: true }).click()
}

async function openDocument() {
  await page.getByRole('button', { name: 'Open another document', exact: true }).click()
  await page.getByLabel('Workspace ID', { exact: true }).fill('design-system')
  await page.getByLabel('Document ID', { exact: true }).fill('hello.tsx')
  await page.getByRole('dialog').getByRole('button', { name: 'Open document', exact: true }).click()
  await page.getByRole('textbox', { name: 'hello.tsx source editor', exact: true }).waitFor()
}

async function screenshot(name: string) {
  if (process.env.WUDANG_E2E_SCREENSHOT_DIR) {
    await page.screenshot({
      path: path.join(process.env.WUDANG_E2E_SCREENSHOT_DIR, name),
      animations: 'disabled',
    })
  }
}

test('account forms live only in Settings; registration and failed sign-in stay usable', async () => {
  expect(await page.getByLabel('Password', { exact: true }).count()).toBe(0)
  expect(await page.getByLabel('Server address', { exact: true }).count()).toBe(0)
  await screenshot('welcome-light.png')
  await page.getByRole('button', { name: /^Workspace settings/ }).click()
  expect(new URL(page.url()).hash).toBe('#/settings')
  await screenshot('settings-light.png')
  await page.getByRole('button', { name: 'Create a local account', exact: true }).click()
  expect(await page.getByLabel('Password', { exact: true }).getAttribute('minlength')).toBe('12')
  await page.getByLabel('Display name', { exact: true }).fill('Alex')
  await page.getByRole('button', { name: 'Back to sign in', exact: true }).click()
  await page.getByLabel('Email', { exact: true }).fill('fail@example.invalid')
  await page.getByLabel('Password', { exact: true }).fill('not-a-real-password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'Unable to sign in' }).waitFor()
  expect(await page.getByLabel('Password', { exact: true }).inputValue()).toBe('')
  expect(new URL(page.url()).hash).toBe('#/settings')
  await page.getByRole('button', { name: 'Create a local account', exact: true }).click()
  await page.getByLabel('Email', { exact: true }).fill('alex@example.invalid')
  await page.getByLabel('Display name', { exact: true }).fill('Alex')
  await page.getByLabel('Password', { exact: true }).fill('ui-test-password')
  await page.getByRole('button', { name: 'Create account', exact: true }).click()
  await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor()
})

test('theme persists, Settings returns to the previous view, and the brand accent stays exact', async () => {
  await page.getByRole('button', { name: 'Threads Preview', exact: true }).click()
  expect(await page.getByRole('button', { name: 'Send message', exact: true }).isDisabled()).toBe(
    true,
  )
  await page.keyboard.press('ControlOrMeta+,')
  await page.getByRole('button', { name: 'Appearance', exact: true }).click()
  await page.getByRole('button', { name: 'Dark', exact: true }).click()
  expect(await page.locator('html').getAttribute('data-theme')).toBe('dark')
  expect(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue('--accent')
        .match(/[\d.]+/g)
        ?.map(Number),
    ),
  ).toEqual([60.56, 0.2189, 292.71])
  await screenshot('appearance-dark.png')
  await page.getByRole('button', { name: 'Close settings', exact: true }).click()
  await page.getByRole('region', { name: 'Agent workspace', exact: true }).waitFor()
  await screenshot('threads-dark.png')
  await page.reload()
  expect(await page.locator('html').getAttribute('data-theme')).toBe('dark')
  await page.keyboard.press('ControlOrMeta+b')
  expect(
    await page.getByRole('complementary', { name: 'Workspace sidebar', exact: true }).count(),
  ).toBe(0)
  await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click()
  expect(
    await page.getByRole('complementary', { name: 'Workspace sidebar', exact: true }).count(),
  ).toBe(1)
})

test('primary actions keep readable text and the specified accent in both themes', async () => {
  await page.getByRole('button', { name: 'Open settings', exact: true }).click()
  for (const theme of ['light', 'dark'] as const) {
    await page.getByRole('button', { name: 'Appearance', exact: true }).click()
    await page
      .getByRole('button', { name: theme === 'light' ? 'Light' : 'Dark', exact: true })
      .click()
    await page.getByRole('button', { name: 'Account', exact: true }).click()
    const contrast = await page
      .getByRole('button', { name: 'Sign in', exact: true })
      .evaluate((button) => {
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 1
        const context = canvas.getContext('2d')!
        function luminance(color: string) {
          context.fillStyle = color
          context.fillRect(0, 0, 1, 1)
          const channels = Array.from(context.getImageData(0, 0, 1, 1).data)
            .slice(0, 3)
            .map((channel) => {
              const value = channel / 255
              return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
            })
          return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
        }
        const style = getComputedStyle(button)
        const foreground = luminance(style.color)
        const background = luminance(style.backgroundColor)
        return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
      })
    expect(contrast).toBeGreaterThanOrEqual(4.5)
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue('--accent')
          .match(/[\d.]+/g)
          ?.map(Number),
      ),
    ).toEqual([60.56, 0.2189, 292.71])
  }
})

test('document failures keep the dialog open; drafts survive Settings and save from the editor', async () => {
  await signIn()
  await page.keyboard.press('ControlOrMeta+o')
  await page.getByLabel('Workspace ID', { exact: true }).fill('design-system')
  await page.getByLabel('Document ID', { exact: true }).fill('missing-document')
  await page.getByRole('dialog').getByRole('button', { name: 'Open document', exact: true }).click()
  await page.getByRole('dialog').getByRole('alert').waitFor()
  expect(await page.getByRole('dialog').isVisible()).toBe(true)
  await page.getByLabel('Document ID', { exact: true }).fill('hello.tsx')
  await page.getByRole('dialog').getByRole('button', { name: 'Open document', exact: true }).click()
  const editor = page.getByRole('textbox', { name: 'hello.tsx source editor', exact: true })
  await editor.waitFor()
  await editor.press('ControlOrMeta+End')
  await page.keyboard.insertText('// a draft worth keeping')
  await page.getByRole('button', { name: 'Open settings', exact: true }).click()
  page.once('dialog', (dialog) => void dialog.dismiss())
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  expect(await page.getByRole('button', { name: 'Sign out', exact: true }).isVisible()).toBe(true)
  await page.getByRole('button', { name: 'Close settings', exact: true }).click()
  expect(await editor.textContent()).toContain('a draft worth keeping')
  await editor.press('ControlOrMeta+s')
  await page.locator('.status-ready').filter({ hasText: 'Saved on server' }).waitFor()
  await screenshot('editor-light.png')
  await page.getByRole('button', { name: 'Open another document', exact: true }).click()
  await page.keyboard.press('Escape')
  expect(await page.getByRole('dialog').count()).toBe(0)
  expect(
    await page
      .getByRole('button', { name: 'Open another document', exact: true })
      .evaluate((element) => element === document.activeElement),
  ).toBe(true)
})

test('opening a document shows pending state and cannot be dismissed mid-request', async () => {
  await signIn()
  await page.getByRole('button', { name: 'Open another document', exact: true }).click()
  await page.getByLabel('Workspace ID', { exact: true }).fill('design-system')
  await page.getByLabel('Document ID', { exact: true }).fill('pending-document')
  await page.getByRole('dialog').getByRole('button', { name: 'Open document', exact: true }).click()
  await page.getByRole('button', { name: 'Opening…', exact: true }).waitFor()
  expect(await page.getByRole('button', { name: 'Close dialog', exact: true }).isDisabled()).toBe(
    true,
  )
  await page.keyboard.press('Escape')
  expect(await page.getByRole('dialog').isVisible()).toBe(true)
  await page.evaluate(() => window.dispatchEvent(new Event('test-open-ready')))
  await page.getByRole('textbox', { name: 'pending-document source editor', exact: true }).waitFor()
})

test('remote updates and disconnects preserve a dirty draft and prevent saving', async () => {
  await signIn()
  await openDocument()
  const editor = page.getByRole('textbox', { name: 'hello.tsx source editor', exact: true })
  await editor.press('ControlOrMeta+End')
  await page.keyboard.insertText('// local draft')
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent('test-document', {
        detail: {
          kind: 'snapshot',
          document: {
            documentId: 'hello.tsx',
            workspaceId: 'design-system',
            text: '// remote edit',
            version: 'remote-2',
          },
        },
      }),
    ),
  )
  await page.getByRole('status').filter({ hasText: 'Remote changes arrived' }).waitFor()
  expect(await editor.textContent()).toContain('// local draft')
  expect(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled()).toBe(true)
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent('test-document', {
        detail: { kind: 'closed', message: 'Connection interrupted.' },
      }),
    ),
  )
  await page.getByRole('status').filter({ hasText: 'Offline' }).waitFor()
  expect(await editor.getAttribute('contenteditable')).toBe('false')
  expect(await editor.textContent()).toContain('// local draft')
})

test('repository management is in Settings and populates the project sidebar', async () => {
  await signIn()
  await page.getByRole('button', { name: 'Manage projects', exact: true }).click()
  await page.getByLabel('Organization ID', { exact: true }).fill('ui-organization')
  await page.getByRole('button', { name: 'Load repositories', exact: true }).click()
  await page.getByLabel('Repository name', { exact: true }).fill('not a valid name')
  expect(
    await page
      .getByLabel('Repository name', { exact: true })
      .evaluate((input: HTMLInputElement) => input.checkValidity()),
  ).toBe(false)
  await page.getByLabel('Repository name', { exact: true }).fill('design-system')
  await page.getByRole('button', { name: 'Create hosted repository', exact: true }).click()
  await page.getByRole('complementary').getByText('design-system', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Close settings', exact: true }).click()
  expect(await page.getByLabel('Organization ID', { exact: true }).count()).toBe(0)
})

test('Settings fits a narrow desktop window and browser preview cannot submit credentials', async () => {
  await page.setViewportSize({ width: 720, height: 560 })
  await page.goto(`${url}/#/settings`)
  await page.getByRole('heading', { name: 'Account', exact: true }).waitFor()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const bounds = await page.getByLabel('Email', { exact: true }).boundingBox()
  expect(bounds !== null && bounds.x >= 0 && bounds.x + bounds.width <= 720).toBe(true)
  await screenshot('settings-narrow.png')
  await page.addInitScript(() => {
    delete window.desktop
  })
  await page.reload()
  await page.getByRole('status').filter({ hasText: 'browser preview' }).waitFor()
  expect(await page.getByRole('button', { name: 'Sign in', exact: true }).isDisabled()).toBe(true)
})
