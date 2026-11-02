import { defineConfig } from 'vitest/config'

// Use one React instance across DSH client packages and tests.
export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom'] },
  test: {
    include: ['tests/**/*.spec.{ts,tsx}'],
    environment: 'node',
    restoreMocks: true,
  },
})
