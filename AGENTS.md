# `mcp-chrome-launcher` — Project Engineering Notes

## Runtime & Packaging Constraints
- **Zero runtime dependencies**: Pure native Node.js ESM (`.mjs`). All test/tooling packages (`vitest`, `vite`, `execa`, `tree-kill-promise`, `@vitest/coverage-v8`) stay strictly in `devDependencies`.
- **Tarball hygiene**: Keep `package.json` `"files"` restricted to `["mcp-chrome-launcher.mjs", "src/", "README.md"]` so `AGENTS.md`, `tests/`, and `vitest.config.mjs` are excluded from npm tarballs.

## Supported Node Versions (Policy)
- Support every Node LTS line that has not reached End-of-Life, plus the latest stable release. Currently **22** (EOL 2027-04-30), **24** (EOL 2028-04-30) and **26** (Active LTS and latest stable, EOL 2029-04-30).
- `engines.node` is an open-ended floor at the oldest supported LTS: `>=22.12.0`, which is also vitest 5's own floor (`^22.12.0 || ^24.0.0 || >=26.0.0`). Never cap it above a supported line.
- CI proves it twice: the 3-OS `test (<os>-latest)` matrix runs the LTS slot via `node-version: 'lts/*'`, so the required check names never move, and `test-lts-floor` runs the oldest supported line explicitly (`22.12.0`) plus `24` on ubuntu with Chrome under `xvfb-run`.
- Retire a line only after its EOL date: raise the floor, drop it from the `test-lts-floor` matrix, and cut a release. Dropping a line is breaking — major at `1.0.0+`, minor while `0.x`.

## Process & Chrome Teardown Order (`tests/application/`)
1. Terminate the launcher child first: call `child.stdin?.end()` and `Promise.race` against a bounded timeout (so V8 flushes subprocess coverage before exit), then `.destroy()` `stdin`/`stderr` streams. A still-running launcher could otherwise spawn a fresh detached Chrome after port cleanup has run.
2. Only then close Chrome cleanly via CDP `Browser.close` over `WebSocket` on the debug port, once no launcher process can restart it.
3. Only if `child.pid && child.exitCode === null`, fall back to `tree-kill-promise` (`kill(child.pid, 'SIGKILL')`).
4. Always `clearTimeout(timer)` on settlement in `Promise.race` / WebSocket helpers.

## `net.Server` Dummy Port Cleanup
- `net.Server` does **not** have `closeAllConnections()` (only `http.Server` does).
- Track accepted sockets in a `Set`, attach `socket.on('error', () => {})` (prevents unhandled `ECONNRESET`), respond/close immediately when simulating a non-HTTP port conflict, and `.destroy()` all tracked sockets before `server.close()`.

## Vitest 5 Native ESM Subprocess Coverage
- `vitest.config.mjs` uses `pool: 'forks'`, `experimental: { viteModuleRunner: false }`, and `coverage: { provider: 'v8', autoAttachSubprocess: true, thresholds: { lines: 100, statements: 100, functions: 100, branches: 100 } }`.
- Run `npm test` for fast verification or `npm run test:coverage` to enforce 100% across all files.

## Release Flow (tag → npm publish)
- `.github/workflows/publish.yml` triggers on any `v*` tag and publishes with **npm Trusted Publishing (OIDC)** and provenance — no `NPM_TOKEN` secret exists.
- Cut a release by bumping the version and pushing the tag:
  ```sh
  npm version patch          # or minor / major; creates commit + vX.Y.Z tag
  git push --follow-tags
  ```
- The workflow runs on `ubuntu-latest`/Node 26, upgrades the npm CLI to `>= 11.5.1`, strips the `_authToken` line that `actions/setup-node` writes (it would otherwise bypass OIDC), runs `npm run test:coverage` under `xvfb-run`, then `npm publish --provenance --access public`.
- `prepublishOnly` re-runs `test:coverage` inside `npm publish`, so that step is also wrapped in `xvfb-run`; keep it that way or the Chrome-backed application tests fail for lack of a display.
- Trusted Publishing is bound to the workflow filename `publish.yml` — renaming it breaks publishing until npmjs.com is updated.
- `server.json` (MCP Registry metadata) pins the same version, and its `name` must equal `mcpName` in `package.json`; bump both fields with every release or the registry rejects the package.
