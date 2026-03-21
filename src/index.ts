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

  if (transition !== null) {
    if (transition.to === 'outage') {
      // Use the probe's own timestamp so outage_start reflects when the failure was
      // observed, not when the state machine evaluated it.
      outageStartedAt = result.timestamp;
      logEvent({
        event: 'outage_start',
        host: result.host,
        port: result.port,
        outageStartedAt,
      });
    } else if (transition.from === 'outage' && outageStartedAt !== null) {
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
  }

  if (!shuttingDown) {
    setTimeout(() => { void tick(); }, machine.getIntervalMs());
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

initLogger(CONFIG.logPath);

logEvent({
  event: 'startup',
  config: CONFIG,
});

void tick();
