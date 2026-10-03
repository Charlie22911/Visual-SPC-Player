import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [
    react(),
    {
      name: 'generate-offline-release',
      apply: 'build',
      async closeBundle() {
        // @ts-expect-error The post-build generator intentionally runs as plain Node ESM.
        const { generateOfflineBuild } = await import('./scripts/offline-build.mjs');
        await generateOfflineBuild();
      },
    },
  ],
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
  },
});
