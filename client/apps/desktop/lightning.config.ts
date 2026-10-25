import { defineConfig } from '@lightning-js/lightning/config'

export default defineConfig({
  test: {
    environment: 'node',
    projects: [
      { test: { name: 'unit', include: ['tests/*.test.ts'] } },
      { test: { name: 'ui', include: ['tests/workspace.ui.ts'], testTimeout: 30_000 } },
      { test: { name: 'integration', include: ['tests/connection.e2e.ts'], testTimeout: 90_000 } },
    ],
  },
})
