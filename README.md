# `mcp-chrome-launcher`

## Why this exists
By default, `chrome-devtools-mcp` launches Chrome with `--remote-debugging-pipe`—a private pipe owned by the MCP process—which **blocks external Puppeteer, Playwright, or CDP scripts from attaching to the same logged-in browser**.

The usual workaround is manually starting Chrome with `--remote-debugging-port` before every session. `mcp-chrome-launcher` eliminates that manual step: it auto-launches a **shared, debuggable Chrome** (`--remote-debugging-port`) lazily on the first `tools/call` and attaches `chrome-devtools-mcp` via `--browserUrl`, so your AI agent and external scripts share one logged-in browser without popping open a window on IDE startup.

## Features
- **Lazy launch**: Starts `chrome-devtools-mcp` immediately over stdio without opening Chrome on IDE startup (`initialize`, `tools/list`).
- **Shared browser session**: Exposes `--remote-debugging-port` (default `9223`) so `chrome-devtools-mcp` and external CDP scripts share one browser.
- **Cross-platform Chrome discovery**: Auto-detects Chrome on Windows, macOS, and Linux, or accepts `--chromePath=<path>`.

## CLI Options
```text
Usage: mcp-chrome-launcher [options] [chrome-devtools-mcp-args...]

Options:
  --port <port>           Remote debugging port (default: 9223)
  --userDataDir <path>    Chrome user data directory (default: ~/.chrome-dev-profile)
  --chromePath <path>     Path to Chrome executable (default: auto-detected)
  -h, --help              Show this help message
  -v, --version           Show version number
```

## Setup (`mcp_config.json`)
1. Close any existing Chrome window using your dev profile in pipe mode before the first launch.
2. Point `chrome-devtools-mcp` in your MCP client config to `mcp-chrome-launcher.mjs`:

```json
{
  "chrome-devtools-mcp": {
    "command": "node",
    "args": [
      "/path/to/mcp-chrome-launcher/mcp-chrome-launcher.mjs",
      "--allowUnrestrictedPaths",
      "--categoryExtensions"
    ]
  }
}
```

## Security Note
Chrome is deliberately left running on `127.0.0.1:<port>` after the MCP exits so external scripts and subsequent sessions can reuse it. Close the browser window when you finish your task to close the debug port.
