import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: true,
  clean: true,
  fixedExtension: false,
  deps: {
    neverBundle: [
      'playwright',
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-web',
      '@deepseek-ai/dsh-settings',
      '@deepseek-ai/schemastery',
    ],
  },
})
