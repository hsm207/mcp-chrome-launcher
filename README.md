# `mcp-chrome-launcher`

[![hsm207/mcp-chrome-launcher MCP server](https://glama.ai/mcp/servers/hsm207/mcp-chrome-launcher/badges/score.svg)](https://glama.ai/mcp/servers/hsm207/mcp-chrome-launcher)

**One persistent, logged-in Chrome shared across all your AI agents, IDE windows, and Playwright/Puppeteer scripts—launched lazily on demand.**

Zero runtime dependencies • Cross-platform (Windows, macOS, Linux) • 100% Test Coverage • Drop-in replacement for `chrome-devtools-mcp`

---

## Why This Exists

By default, Google's `chrome-devtools-mcp` launches Chrome over a **private pipe** (`--remote-debugging-pipe`) and locks the user profile directory. That creates three daily headaches:

1. **Multi-Window & Sub-Agent Crashes (`SingletonLock`)**: Opening a second Cursor/VS Code workspace or running parallel Claude Code sessions crashes because the first MCP process locked the profile.
2. **Playwright & Puppeteer Lockout**: Because the pipe is private to the MCP process, your own Playwright, Puppeteer, or custom CDP scripts cannot attach to the same logged-in browser.
3. **Manual Pre-Launch Chores (or `--isolated` Login Amnesia)**: Using `--isolated` wipes your logins every run, while `--browserUrl` forces you to manually boot Chrome with special flags from a terminal before opening your IDE.

`mcp-chrome-launcher` fixes all three automatically. Drop it in place of `chrome-devtools-mcp`—it stays completely invisible on IDE startup, **lazy-launches one detached Chrome on `127.0.0.1:9223` the moment a browser tool is actually called**, and connects every MCP client and external script to that single warm, logged-in session.

| Capability | Default `chrome-devtools-mcp` | `chrome-devtools-mcp --isolated` | **`mcp-chrome-launcher`** |
| :--- | :---: | :---: | :---: |
| Keeps logins, cookies & extensions | ✅ | ❌ (Wiped every run) | **✅** |
| Multiple IDE windows & parallel agents | ❌ (`SingletonLock` crash) | ✅ (Separate browsers) | **✅ (One shared browser)** |
| Attach Playwright / Puppeteer / CDP scripts | ❌ (Private pipe) | ❌ (Private pipe) | **✅ (`http://127.0.0.1:9223`)** |
| Zero browser popup on IDE startup | ❌ / Varies | ❌ / Varies | **✅ (Lazy-launches on `tools/call`)** |
| Survives IDE / agent restarts | ❌ | ❌ | **✅ (Detached process)** |

---

## Quick Start (Drop-In Replacement)

Replace `chrome-devtools-mcp` with `mcp-chrome-launcher` in your MCP config (`claude_desktop_config.json`, `.cursor/mcp.json`, Windsurf, Gemini CLI, etc.). Any extra flags pass straight through to `chrome-devtools-mcp`!

*(Before first run: close any existing Chrome window already holding `~/.chrome-dev-profile` without remote debugging.)*

### Via `npx` (Recommended)
```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-chrome-launcher@latest"
      ]
    }
  }
}
```

### Claude Code CLI (One-Liner)
```bash
claude mcp add chrome-devtools -- npx -y mcp-chrome-launcher@latest
```

### Local Clone / Custom Flags
Any unrecognized flags (like `--categoryExtensions`) forward directly to `chrome-devtools-mcp`:
```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "node",
      "args": [
        "/path/to/mcp-chrome-launcher/mcp-chrome-launcher.mjs",
        "--port=9223",
        "--allowUnrestrictedPaths",
        "--categoryExtensions"
      ]
    }
  }
}
```

---

## Bonus: Attach Playwright or Puppeteer to the Same Browser

Because Chrome exposes its DevTools endpoint locally on `127.0.0.1:9223`, your own E2E scripts or scrapers can jump right into the exact browser session your AI agent is driving:

```js
import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
const context = browser.contexts()[0];
const page = context.pages()[0];
console.log('Sharing live tab with MCP:', await page.title());
```

---

## How It Works

1. **Instant Handshake**: Starts `chrome-devtools-mcp` immediately over stdio so `initialize` and `tools/list` finish fast without opening a browser window.
2. **Lazy Launch on First `tools/call`**: Pauses `stdin` on the first tool invocation, checks if `127.0.0.1:<port>` is already live, and—if not—spawns a detached Chrome instance and waits until DevTools responds.
3. **Clear Conflict Diagnostics**: Immediately detects and logs clear errors to `stderr` if another process owns the port or an un-debugged Chrome holds the profile lock.
4. **Cross-Platform Discovery**: Automatically locates Chrome/Chromium on Windows, macOS, and Linux (or accepts `--chromePath`).

---

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

## Security Note
Chrome is intentionally spawned detached and bound strictly to loopback (`127.0.0.1:<port>`) so subsequent agent sessions and local scripts can reuse your warm tabs. Any local process on your machine can connect to `127.0.0.1:<port>` while that browser window stays open—quit that Chrome window when finished to close the debug port.
