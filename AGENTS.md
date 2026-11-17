# `mcp-chrome-launcher` — Project Engineering Notes

## Runtime & Packaging Constraints
- **Zero runtime dependencies**: Pure native Node.js ESM (`.mjs`). All test/tooling packages (`vitest`, `vite`, `execa`, `tree-kill-promise`, `@vitest/coverage-v8`) stay strictly in `devDependencies`.
- **Tarball hygiene**: Keep `package.json` `"files"` restricted to `["mcp-chrome-launcher.mjs", "src/", "README.md"]` so `AGENTS.md`, `tests/`, and `vitest.config.mjs` are excluded from npm tarballs.

## Process & Chrome Teardown Order (`tests/application/`)
1. Close Chrome cleanly via CDP `Browser.close` over `WebSocket` on the debug port.
2. Call `child.stdin?.end()` and `Promise.race` against a bounded timeout (so V8 flushes subprocess coverage before exit), then `.destroy()` `stdin`/`stderr` streams.
3. Only if `child.pid && child.exitCode === null`, fall back to `tree-kill-promise` (`kill(child.pid, 'SIGKILL')`).
4. Always `clearTimeout(timer)` on settlement in `Promise.race` / WebSocket helpers.

## `net.Server` Dummy Port Cleanup
- `net.Server` does **not** have `closeAllConnections()` (only `http.Server` does).
- Track accepted sockets in a `Set`, attach `socket.on('error', () => {})` (prevents unhandled `ECONNRESET`), respond/close immediately when simulating a non-HTTP port conflict, and `.destroy()` all tracked sockets before `server.close()`.

## Vitest 5 Native ESM Subprocess Coverage
- `vitest.config.mjs` uses `pool: 'forks'`, `experimental: { viteModuleRunner: false }`, and `coverage: { provider: 'v8', autoAttachSubprocess: true, thresholds: { lines: 100, statements: 100, functions: 100, branches: 100 } }`.
- Run `npm test` for fast verification or `npm run test:coverage` to enforce 100% across all files.
