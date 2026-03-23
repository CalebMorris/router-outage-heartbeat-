import { Config, Endpoint } from './config';
import { EndpointHealth } from './endpoint-health';
import { LogEvent } from './logger';
import { PingResult } from './pinger';
import { EndpointRotator } from './rotator';
import { StateMachine } from './state-machine';

type ProbeFn = (host: string, port: number, timeoutMs: number) => Promise<PingResult>;
type LogFn = (event: LogEvent) => void;

export class Monitor {
  private readonly machine: StateMachine;
  private readonly rotator: EndpointRotator;
  private readonly health: EndpointHealth;
  private readonly probe: ProbeFn;
  private readonly log: LogFn;
  private readonly config: Config;
  private readonly endpoints: Endpoint[];
  private shuttingDown = false;
  private outageStartedAt: string | null = null;

  constructor(deps: {
    config: Config;
    endpoints: Endpoint[];
    probe: ProbeFn;
    log: LogFn;
  }) {
    this.config = deps.config;
    this.endpoints = deps.endpoints;
    this.probe = deps.probe;
    this.log = deps.log;
    this.machine = new StateMachine(deps.config);
    this.rotator = new EndpointRotator(deps.endpoints);
    this.health = new EndpointHealth({
      initialBackoffMs: deps.config.endpointQuarantineInitialBackoffMs,
      maxBackoffMs: deps.config.endpointQuarantineMaxBackoffMs,
      multiplier: deps.config.endpointQuarantineBackoffMultiplier,
    });
  }

  public start(): void {
    setTimeout(() => { void this.tick(); }, 0);
  }

  public shutdown(reason: string): void {
    this.shuttingDown = true;
    this.log({ event: 'shutdown', reason });
    process.exit(0);
  }

  private scheduleRecheck(ep: Endpoint, delayMs: number): void {
    setTimeout(() => { void this.recheck(ep); }, delayMs);
  }

  private async recheck(ep: Endpoint): Promise<void> {
    if (this.shuttingDown) return;
    if (!this.health.isQuarantined(ep)) return; // already restored

    // Capture quarantinedAt before recordRecheckResult may remove the entry.
    const quarantinedAt = this.health.getQuarantinedAt(ep) ?? new Date().toISOString();

    const result = await this.probe(ep.host, ep.port, this.config.pingTimeoutMs);
    const now = new Date();
    const outcome = this.health.recordRecheckResult(ep, result.success, now);

    if (outcome === 'restored') {
      const restoredAt = now.toISOString();
      const durationMs = now.getTime() - new Date(quarantinedAt).getTime();
      this.log({
        event: 'endpoint_restored',
        host: ep.host,
        port: ep.port,
        quarantinedAt,
        restoredAt,
        durationMs,
      });
    } else {
      // Backoff: schedule next recheck
      const nextCheckAt = this.health.getNextCheckAt(ep);
      if (nextCheckAt !== null && !this.shuttingDown) {
        const delay = Math.max(0, nextCheckAt - Date.now());
        this.scheduleRecheck(ep, delay);
      }
    }
  }

  private quarantineEndpoint(ep: Endpoint, now: Date): void {
    const activeCount = this.endpoints.length - this.health.size();
    if (activeCount - 1 < this.config.minActiveEndpoints) {
      return; // floor guard: skip quarantine to preserve minimum active pool
    }
    if (this.health.isQuarantined(ep)) return;

    this.health.quarantine(ep, now);
    this.log({
      event: 'endpoint_quarantined',
      host: ep.host,
      port: ep.port,
      backoffMs: this.config.endpointQuarantineInitialBackoffMs,
    });

    // Schedule independent recheck timer (not in main tick)
    this.scheduleRecheck(ep, this.config.endpointQuarantineInitialBackoffMs);
  }

  private async tick(): Promise<void> {
    const tickStart = Date.now();
    const quarantined = this.health.getQuarantinedKeys();
    const endpoint = this.rotator.next(quarantined);
    const result = await this.probe(endpoint.host, endpoint.port, this.config.pingTimeoutMs);
    const transition = this.machine.process(result);

    this.log({
      event: 'probe',
      host: result.host,
      port: result.port,
      success: result.success,
      latencyMs: result.latencyMs,
      state: this.machine.getState(),
    });

    if (transition !== null && transition.to === 'bulkhead') {
      const firstFailureTimestamp = result.timestamp;
      const activeEndpoints = this.endpoints.filter((e) => !this.health.isQuarantined(e));
      const bulkheadResults = await Promise.all(
        activeEndpoints.map((e) => this.probe(e.host, e.port, this.config.pingTimeoutMs)),
      );
      const failed = bulkheadResults.filter((r) => !r.success);
      const failedCount = failed.length;
      const failedEndpoints = failed.map((r) => ({ host: r.host, port: r.port }));
      const majorityFailed = failedCount > activeEndpoints.length / 2;
      const checkedAt = new Date().toISOString();

      this.log({
        event: 'bulkhead_check',
        totalEndpoints: activeEndpoints.length,
        failedCount,
        majorityFailed,
        failedEndpoints,
      });

      const bulkheadTransition = this.machine.processBulkheadResult(majorityFailed, checkedAt);

      if (bulkheadTransition.to === 'outage') {
        this.outageStartedAt = firstFailureTimestamp;
        this.log({
          event: 'outage_start',
          host: result.host,
          port: result.port,
          outageStartedAt: this.outageStartedAt,
        });
      } else {
        // Partial failure: quarantine failing endpoints
        const now = new Date();
        for (const ep of failedEndpoints) {
          this.quarantineEndpoint(ep, now);
        }
      }
    } else if (transition !== null && transition.from === 'outage' && this.outageStartedAt !== null) {
      const outageEndedAt = result.timestamp;
      const durationMs = new Date(outageEndedAt).getTime() - new Date(this.outageStartedAt).getTime();
      this.log({
        event: 'outage_end',
        durationMs,
        outageStartedAt: this.outageStartedAt,
        outageEndedAt,
      });
      this.outageStartedAt = null;
    }

    if (!this.shuttingDown) {
      const elapsed = Date.now() - tickStart;
      const delay = Math.max(0, this.machine.getIntervalMs() - elapsed);
      setTimeout(() => { void this.tick(); }, delay);
    }
  }
}
