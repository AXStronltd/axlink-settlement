import 'dotenv/config';
import { app, cfgReport } from './app';
import { startRuntime } from './bootstrap/runtime';
import { log } from './platform/logger';

// Compatibility for HTTP tests and existing imports; no workers or listener on import.
export { app } from './app';

if (require.main === module) {
  startRuntime(cfgReport.config).then(() => {
    app.listen(cfgReport.config.PORT, () => {
      log.info('startup.listening', { port: cfgReport.config.PORT, env: cfgReport.config.NODE_ENV });
    });
  }).catch(err => {
    log.error('startup.failed', { message: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}
