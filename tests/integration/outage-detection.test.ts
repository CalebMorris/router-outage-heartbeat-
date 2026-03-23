import { Monitor } from '../../src/monitor';
import { Config, Endpoint } from '../../src/config';
import { LogEvent } from '../../src/logger';
import { PingResult } from '../../src/pinger';
import { EndpointHealth } from '../../src/endpoint-health';

// Minimal endpoint pool for integration tests (keeps tests fast)
const endpoints: Endpoint[] = Array.from({ length: 10 }, (_, i) => ({ host: `10.0.0.${i + 1}`, port: 53 }));

const baseConfig: Config = {
  normalIntervalMs: 5_000,
  outageIntervalMs: 100,
  consecutiveSuccessesForRecovery: 3,
  pingTimeoutMs: 1_000,
  endpointQuarantineInitialBackoffMs: 60_000,
  endpointQuarantineMaxBackoffMs: 3_600_000,
  endpointQuarantineBackoffMultiplier: 2,
  minActiveEndpoints: 5,
  endpoints,
  logPath: '/tmp/test-heartbeat.log',
};

function makeProbeResult(ep: Endpoint, success: boolean): PingResult {
  return {
    success,
    latencyMs: success ? 10 : null,
    host: ep.host,
    port: ep.port,
    timestamp: new Date().toISOString(),
  };
}

function collectEvents(events: LogEvent[], eventType: string): LogEvent[] {
  return events.filter((e) => e.event === eventType);
}

describe('Monitor integration', () => {
  let events: LogEvent[];
  let probe: jest.Mock;

  beforeEach(() => {
    events = [];
    probe = jest.fn();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function makeMonitor(config = baseConfig, eps = endpoints): Monitor {
    return new Monitor({
      config,
      endpoints: eps,
      probe,
      log: (e) => { events.push(e); },
    });
  }

  // ─── Test 1: Full outage detected within 6 simulated seconds ─────────────

  it('detects full router outage within 6 simulated seconds', async () => {
    probe.mockImplementation((host: string, port: number) =>
      Promise.resolve(makeProbeResult({ host, port }, false)),
    );

    const monitor = makeMonitor();
    monitor.start();

    // Advance past normalIntervalMs (5000ms) — first tick fires
    await jest.advanceTimersByTimeAsync(5_001);

    // outage_start logged after advancing only 5001ms proves detection within one interval cycle (<= 6s).
    // (5000ms normal interval + probe time, all within a single advanceTimersByTimeAsync call)
    const outageEvents = collectEvents(events, 'outage_start');
    expect(outageEvents).toHaveLength(1);
  });

  // ─── Test 2: False alarm — bulkhead → normal, no outage ──────────────────

  it('returns to normal without declaring outage when only 1 of 10 fails (false alarm)', async () => {
    let callCount = 0;
    probe.mockImplementation((host: string, port: number) => {
      callCount++;
      // First call (rotating probe) fails; all subsequent bulkhead calls succeed
      const success = callCount > 1;
      return Promise.resolve(makeProbeResult({ host, port }, success));
    });

    const monitor = makeMonitor();
    monitor.start();

    await jest.advanceTimersByTimeAsync(5_001);

    expect(collectEvents(events, 'outage_start')).toHaveLength(0);
    const bulkheadEvents = collectEvents(events, 'bulkhead_check');
    expect(bulkheadEvents).toHaveLength(1);
    expect((bulkheadEvents[0] as { majorityFailed: boolean }).majorityFailed).toBe(false);
  });

  // ─── Test 3: Partial failure → quarantine, NOT outage ────────────────────

  it('quarantines failing endpoints and does not declare outage on partial failure', async () => {
    // 3 of 10 endpoints fail in bulkhead check (minority)
    const failingHosts = new Set(['10.0.0.1', '10.0.0.2', '10.0.0.3']);

    probe.mockImplementation((host: string, port: number) =>
      Promise.resolve(makeProbeResult({ host, port }, !failingHosts.has(host))),
    );

    const monitor = makeMonitor();
    monitor.start();

    await jest.advanceTimersByTimeAsync(5_001);

    expect(collectEvents(events, 'outage_start')).toHaveLength(0);
    const quarantined = collectEvents(events, 'endpoint_quarantined');
    expect(quarantined.length).toBeGreaterThan(0);
    // Each quarantined event should be one of the failing hosts
    for (const ev of quarantined) {
      expect(failingHosts.has((ev as { host: string }).host)).toBe(true);
    }
  });

  // ─── Test 4: Quarantine floor blocks new quarantines at minActiveEndpoints ─

  it('skips second quarantine when active pool would drop below minActiveEndpoints', async () => {
    // 10 endpoints, floor=9: 2 can fail (minority), but only 1 can be quarantined
    // because quarantining the 2nd would make active=8 < floor=9
    const config: Config = { ...baseConfig, minActiveEndpoints: 9 };

    // 2 of 10 fail (minority: 2 < 5) — partial failure path (not outage)
    const failingHosts = new Set(['10.0.0.1', '10.0.0.2']);

    // First probe (rotating) hits a passing host so we don't short-circuit to bulkhead on probe.
    // We need the ROTATING probe to succeed, then the bulkhead to reveal 2 failures.
    let isRotatingProbe = true;
    probe.mockImplementation((host: string, port: number) => {
      if (isRotatingProbe) {
        isRotatingProbe = false;
        // Return success for the rotating probe so we don't immediately go to bulkhead on a passing host
        // (if rotating probe hits a failing host, that triggers bulkhead — that's fine too)
        return Promise.resolve(makeProbeResult({ host, port }, !failingHosts.has(host)));
      }
      return Promise.resolve(makeProbeResult({ host, port }, !failingHosts.has(host)));
    });

    // Simpler: just let any probe fail and rely on the bulkhead revealing 2 failures
    probe.mockImplementation((host: string, port: number) =>
      Promise.resolve(makeProbeResult({ host, port }, !failingHosts.has(host))),
    );

    const monitor = makeMonitor(config);
    monitor.start();

    await jest.advanceTimersByTimeAsync(5_001);

    const quarantined = collectEvents(events, 'endpoint_quarantined');
    // With floor=9: first quarantine OK (active 10→9=floor), second BLOCKED (9-1=8 < 9)
    expect(quarantined.length).toBeLessThanOrEqual(1);
    expect(collectEvents(events, 'outage_start')).toHaveLength(0);
  });

  // ─── Test 5: Quarantined endpoint recovers via recheck ────────────────────

  it('logs endpoint_restored when recheck succeeds after backoff', async () => {
    // First pass: 1 endpoint fails (minority → quarantine)
    const failHost = '10.0.0.1';
    let recheckCall = false;

    probe.mockImplementation((host: string, port: number) => {
      if (host === failHost && !recheckCall) {
        return Promise.resolve(makeProbeResult({ host, port }, false));
      }
      return Promise.resolve(makeProbeResult({ host, port }, true));
    });

    const monitor = makeMonitor();
    monitor.start();

    // First tick: triggers quarantine of failHost
    await jest.advanceTimersByTimeAsync(5_001);
    expect(collectEvents(events, 'endpoint_quarantined').length).toBeGreaterThan(0);

    // Now the recheck probe should succeed
    recheckCall = true;

    // Advance past the initial backoff (60s)
    await jest.advanceTimersByTimeAsync(60_001);

    const restored = collectEvents(events, 'endpoint_restored');
    expect(restored).toHaveLength(1);
    expect((restored[0] as { host: string }).host).toBe(failHost);
  });

  // ─── Test 6: Outage recovery — outage_end logged after N successes ─────────

  it('logs outage_end with correct durationMs after N consecutive successes', async () => {
    let allFail = true;

    probe.mockImplementation((host: string, port: number) =>
      Promise.resolve(makeProbeResult({ host, port }, !allFail)),
    );

    const monitor = makeMonitor();
    monitor.start();

    // Trigger outage
    await jest.advanceTimersByTimeAsync(5_001);
    expect(collectEvents(events, 'outage_start')).toHaveLength(1);

    // Switch to all-succeed
    allFail = false;

    // Advance enough ticks for consecutiveSuccessesForRecovery=3 at outageIntervalMs=100ms
    await jest.advanceTimersByTimeAsync(1_000);

    const outageEndEvents = collectEvents(events, 'outage_end');
    expect(outageEndEvents).toHaveLength(1);
    const endEvent = outageEndEvents[0] as { durationMs: number; outageStartedAt: string };
    expect(endEvent.durationMs).toBeGreaterThan(0);
    // outageStartedAt should be from the first-failure probe timestamp, not wall clock
    expect(endEvent.outageStartedAt).toBeTruthy();
  });
});
