import { CONFIG } from './config';
import { probeEndpoint } from './pinger';
import { EndpointRotator } from './rotator';
import { StateMachine } from './state-machine';
import { initLogger, logEvent } from './logger';

const rotator = new EndpointRotator(CONFIG.endpoints);
const machine = new StateMachine(CONFIG);

let shuttingDown = false;
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
      outageStartedAt = transition.at;
      logEvent({
        event: 'outage_start',
        host: result.host,
        port: result.port,
        outageStartedAt: transition.at,
      });
    } else if (transition.from === 'outage' && outageStartedAt !== null) {
      const outageEndedAt = transition.at;
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

initLogger(CONFIG.logPath);

logEvent({
  event: 'startup',
  config: CONFIG,
});

void tick();
