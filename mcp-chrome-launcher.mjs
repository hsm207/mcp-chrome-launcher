import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { HELP_TEXT, partitionArgs } from './src/cli-options.mjs';
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
  const cliArgs = process.argv.slice(2);
  const { help, version } = partitionArgs(cliArgs);

  if (help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }
  if (version) {
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
    console.log(pkg.version);
    process.exit(0);
  }

  launchAndRun(cliArgs)
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`[mcp-chrome-launcher] ${err.message}`);
      process.exit(1);
    });
}
