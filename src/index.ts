import { CONFIG } from './config';
import { probeEndpoint } from './pinger';
import { EndpointRotator } from './rotator';
import { StateMachine } from './state-machine';
import { initLogger, logEvent, reopenLog } from './logger';

const rotator = new EndpointRotator(CONFIG.endpoints);
const machine = new StateMachine(CONFIG);

let shuttingDown = false;
// Track the probe timestamp of the first failure to accurately record outage start.
let outageStartedAt: string | null = null;

async function tick(): Promise<void> {
  const tickStart = Date.now();
  const endpoint = rotator.next();
  const result = await probeEndpoint(endpoint.host, endpoint.port, CONFIG.pingTimeoutMs);
  const transition = machine.process(result);

  logEvent({
    event: 'probe',
    host: result.host,
    port: result.port,
    success: result.success,
    latencyMs: result.latencyMs,
    state: machine.getState(),
  });

  if (transition !== null && transition.to === 'bulkhead') {
    // First failure detected — immediately blast all endpoints to confirm outage.
    const firstFailureTimestamp = result.timestamp;
    const bulkheadResults = await Promise.all(
      CONFIG.endpoints.map((e) => probeEndpoint(e.host, e.port, CONFIG.pingTimeoutMs)),
    );
    const failed = bulkheadResults.filter((r) => !r.success);
    const failedCount = failed.length;
    const failedEndpoints = failed.map((r) => ({ host: r.host, port: r.port }));
    const majorityFailed = failedCount > CONFIG.endpoints.length / 2;
    const checkedAt = new Date().toISOString();

    logEvent({
      event: 'bulkhead_check',
      totalEndpoints: CONFIG.endpoints.length,
      failedCount,
      majorityFailed,
      failedEndpoints,
    });

    const bulkheadTransition = machine.processBulkheadResult(majorityFailed, checkedAt);

    if (bulkheadTransition.to === 'outage') {
      outageStartedAt = firstFailureTimestamp;
      logEvent({
        event: 'outage_start',
        host: result.host,
        port: result.port,
        outageStartedAt,
      });
    }
    // If bulkheadTransition.to === 'normal': false alarm, no outage event needed.
  } else if (transition !== null && transition.from === 'outage' && outageStartedAt !== null) {
    const outageEndedAt = result.timestamp;
    const durationMs = new Date(outageEndedAt).getTime() - new Date(outageStartedAt).getTime();
    logEvent({
      event: 'outage_end',
      durationMs,
      outageStartedAt,
      outageEndedAt,
    });
    outageStartedAt = null;
  }

  if (!shuttingDown) {
    const elapsed = Date.now() - tickStart;
    const delay = Math.max(0, machine.getIntervalMs() - elapsed);
    setTimeout(() => { void tick(); }, delay);
  }
}

function shutdown(reason: string): void {
  shuttingDown = true;
  logEvent({ event: 'shutdown', reason });
  process.exit(0);
}

process.on('SIGTERM', () => { shutdown('SIGTERM'); });
process.on('SIGINT', () => { shutdown('SIGINT'); });
// SIGHUP: reopen the log file after logrotate has rotated it.
process.on('SIGHUP', () => { reopenLog(); });

async function main(): Promise<void> {
  initLogger(CONFIG.logPath);

  const endpointList = CONFIG.endpoints.map((e) => `${e.host}:${e.port}`).join(', ');
  process.stderr.write(`router-outage-heartbeat starting — monitoring: ${endpointList}\n`);

  logEvent({
    event: 'startup',
    config: CONFIG,
  });

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

  void tick();
}

void main();
