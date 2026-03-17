import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/test/**/*.test.ts'],
    exclude: [
      'src/test/AcpAdapter.test.ts',            // legacy integration test, not vitest
      'src/test/e2e-session-binding.test.ts',    // legacy custom harness
      'src/test/e2e-session-binding-v2.test.ts', // legacy custom harness
      'src/test/frontmatter-qa.test.ts',         // legacy custom harness
      'src/test/t3-precipitation.test.ts',       // legacy custom harness
    ],
    environment: 'node',
  },
});
