import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks',
    experimental: {
      viteModuleRunner: false,
    },
    coverage: {
      provider: 'v8',
      include: ['mcp-chrome-launcher.mjs', 'src/**/*.mjs'],
      autoAttachSubprocess: true,
      thresholds: {
        lines: 100,
        statements: 100,
        functions: 100,
        branches: 100,
      },
    },
  },
});
