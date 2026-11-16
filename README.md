# `mcp-chrome-launcher.mjs`

Launches a headed Chrome instance on `127.0.0.1:9223` (detached, using `C:\Users\mohds\.chrome-dev-profile`) if not already running, then attaches `chrome-devtools-mcp` via `--browserUrl=http://127.0.0.1:9223`. External `puppeteer-core` scripts can share the same browser over `:9223`.

## 1. One-time setup
Close any existing Chrome window using `C:\Users\mohds\.chrome-dev-profile` (started in pipe mode) before the first launch.

## 2. `mcp_config.json` change
Replace `chrome-devtools-mcp` in `C:\Users\mohds\.gemini\config\mcp_config.json` with:

```json
    "chrome-devtools-mcp": {
      "command": "node",
      "args": [
        "C:\\Users\\mohds\\.gemini\\scripts\\mcp-chrome-launcher.mjs",
        "--userDataDir=C:\\Users\\mohds\\.chrome-dev-profile",
        "--logFile",
        "C:\\Users\\mohds\\.gemini\\antigravity\\chrome-devtools-mcp.log",
        "--allowUnrestrictedPaths",
        "--categoryExtensions"
      ]
    }
```

(And remove the temporary `chrome-devtools-mcp-launcher` entry.)

## 3. Rollback
Restore the original `chrome-devtools-mcp` block:

```json
    "chrome-devtools-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "chrome-devtools-mcp@latest",
        "--headless=false",
        "--userDataDir=C:\\Users\\mohds\\.chrome-dev-profile",
        "--logFile",
        "C:\\Users\\mohds\\.gemini\\antigravity\\chrome-devtools-mcp.log",
        "--allowUnrestrictedPaths",
        "--categoryExtensions"
      ]
    }
```

## 4. Security note
Chrome is deliberately left running on `127.0.0.1:9223` after the MCP exits. Close the browser window when you finish your task to close the debug port.
