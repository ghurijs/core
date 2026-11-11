import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/node.ts', 'src/testing.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  // Keep `node:async_hooks` as written: Workers (nodejs_compat) and Node both resolve the prefixed form.
  removeNodeProtocol: false,
  external: [/^@ghuri\//, /^node:/, 'cloudflare:workers', 'hono', /^hono\//, '@hono/node-server'],
})
