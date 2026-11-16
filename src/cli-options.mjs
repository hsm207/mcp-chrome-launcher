import os from 'node:os';
import path from 'node:path';

export const DEFAULT_PORT = 9223;
export const DEFAULT_USER_DATA_DIR = path.join(os.homedir(), '.chrome-dev-profile');

export const HELP_TEXT = `Usage: mcp-chrome-launcher [options] [chrome-devtools-mcp-args...]

Options:
  --port <port>           Remote debugging port (default: ${DEFAULT_PORT})
  --userDataDir <path>    Chrome user data directory (default: ~/.chrome-dev-profile)
  --chromePath <path>     Path to Chrome executable (default: auto-detected)
  -h, --help              Show this help message
  -v, --version           Show version number
`;

/**
 * Partitions CLI args into launcher-owned flags and MCP-forwarded flags.
 * @param {string[]} [args]
 */
export function partitionArgs(args = []) {
  let port = DEFAULT_PORT;
  let userDataDir = DEFAULT_USER_DATA_DIR;
  let chromePath = null;
  let help = false;
  let version = false;
  let headless = false;
  const mcpArgs = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--version' || arg === '-v') {
      version = true;
    } else if (arg.startsWith('--port=')) {
      port = parsePort(arg.slice('--port='.length));
    } else if (arg === '--port' && i + 1 < args.length) {
      port = parsePort(args[++i]);
    } else if (arg.startsWith('--userDataDir=')) {
      userDataDir = arg.slice('--userDataDir='.length);
    } else if (arg === '--userDataDir' && i + 1 < args.length) {
      userDataDir = args[++i];
    } else if (arg.startsWith('--chromePath=')) {
      chromePath = arg.slice('--chromePath='.length);
    } else if (arg === '--chromePath' && i + 1 < args.length) {
      chromePath = args[++i];
    } else {
      mcpArgs.push(arg);
    }
  }

  return { port, userDataDir, chromePath, help, version, headless, mcpArgs };
}

function parsePort(raw) {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid --port value "${raw}". Expected an integer between 1 and 65535.`);
  }
  return port;
}
