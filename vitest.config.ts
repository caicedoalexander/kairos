import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
      exclude: ['dist/**', '**/*.test.ts', 'vitest.*.ts', 'flue.config.ts'],
    },
  },
});
