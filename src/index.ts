import { CONFIG } from './config';
import { initLogger, logEvent, reopenLog } from './logger';
import { Monitor } from './monitor';
import { probeEndpoint } from './pinger';

async function main(): Promise<void> {
  initLogger(CONFIG.logPath);

  const endpointList = CONFIG.endpoints.map((e) => `${e.host}:${e.port}`).join(', ');
  process.stderr.write(`router-outage-heartbeat starting — monitoring: ${endpointList}\n`);

  logEvent({ event: 'startup', config: CONFIG });

  const healthResults = await Promise.all(
    CONFIG.endpoints.map((e) => probeEndpoint(e.host, e.port, CONFIG.pingTimeoutMs)),
  );
  const failed = healthResults.filter((r) => !r.success);
  logEvent({
    event: 'startup_health_check',
    totalEndpoints: CONFIG.endpoints.length,
    failedCount: failed.length,
    failedEndpoints: failed.map((r) => ({ host: r.host, port: r.port })),
    allHealthy: failed.length === 0,
  });

  const monitor = new Monitor({
    config: CONFIG,
    endpoints: CONFIG.endpoints,
    probe: probeEndpoint,
    log: logEvent,
  });

  process.on('SIGTERM', () => { monitor.shutdown('SIGTERM'); });
  process.on('SIGINT', () => { monitor.shutdown('SIGINT'); });
  // SIGHUP: reopen the log file after logrotate has rotated it.
  process.on('SIGHUP', () => { reopenLog(); });

  monitor.start();
}

void main();
