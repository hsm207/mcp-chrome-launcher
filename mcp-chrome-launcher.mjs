import { pathToFileURL } from 'node:url';
import { launchAndRun } from './src/mcp-stdio-bridge.mjs';

export { partitionArgs } from './src/cli-options.mjs';
export { findChromePath } from './src/chrome-discovery.mjs';
export {
  buildChromeSpawnSpec,
  diagnoseStartupFailure,
  hasProfileLock,
  isPortOccupied,
  isPortReady,
  waitForPort,
} from './src/chrome-debug-session.mjs';
export {
  buildMcpSpawnSpec,
  isToolCallMessage,
  launchAndRun,
  runPassthrough,
  wireLifecycle,
} from './src/mcp-stdio-bridge.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  launchAndRun(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`[mcp-chrome-launcher] ${err.message}`);
      process.exit(1);
    });
}
