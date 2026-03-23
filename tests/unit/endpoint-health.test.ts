import { EndpointHealth } from '../../src/endpoint-health';
import { Endpoint } from '../../src/config';

const cfg = { initialBackoffMs: 60_000, maxBackoffMs: 3_600_000, multiplier: 2 };

function ep(host: string, port = 53): Endpoint {
  return { host, port };
}

describe('EndpointHealth', () => {
  describe('quarantine()', () => {
    it('adds endpoint and isQuarantined returns true', () => {
      const h = new EndpointHealth(cfg);
      const now = new Date();
      h.quarantine(ep('1.1.1.1'), now);
      expect(h.isQuarantined(ep('1.1.1.1'))).toBe(true);
    });

    it('is a no-op if already quarantined', () => {
      const h = new EndpointHealth(cfg);
      const t1 = new Date(1000);
      const t2 = new Date(2000);
      h.quarantine(ep('1.1.1.1'), t1);
      h.quarantine(ep('1.1.1.1'), t2);
      // quarantinedAt should be from first call
      expect(h.getQuarantinedAt(ep('1.1.1.1'))).toBe(t1.toISOString());
    });

    it('tracks separate endpoints independently', () => {
      const h = new EndpointHealth(cfg);
      h.quarantine(ep('1.1.1.1'), new Date());
      expect(h.isQuarantined(ep('8.8.8.8'))).toBe(false);
    });
  });

  describe('getDueForRecheck()', () => {
    it('returns nothing before backoff elapses', () => {
      const h = new EndpointHealth(cfg);
      const t0 = new Date(0);
      h.quarantine(ep('1.1.1.1'), t0);
      // At t0 + 59999ms, not yet due
      expect(h.getDueForRecheck(new Date(59_999))).toHaveLength(0);
    });

    it('returns endpoint at exactly initialBackoffMs (boundary inclusive)', () => {
      const h = new EndpointHealth(cfg);
      const t0 = new Date(0);
      h.quarantine(ep('1.1.1.1'), t0);
      expect(h.getDueForRecheck(new Date(60_000))).toHaveLength(1);
    });

    it('returns only due endpoints when multiple are quarantined', () => {
      const h = new EndpointHealth(cfg);
      const t0 = new Date(0);
      h.quarantine(ep('1.1.1.1'), t0);
      h.quarantine(ep('8.8.8.8'), new Date(30_000)); // not due at t=60s
      const due = h.getDueForRecheck(new Date(60_000));
      expect(due).toHaveLength(1);
      expect(due[0].host).toBe('1.1.1.1');
    });
  });

  describe('recordRecheckResult()', () => {
    it('success: removes endpoint and returns restored', () => {
      const h = new EndpointHealth(cfg);
      h.quarantine(ep('1.1.1.1'), new Date(0));
      const outcome = h.recordRecheckResult(ep('1.1.1.1'), true, new Date(60_000));
      expect(outcome).toBe('restored');
      expect(h.isQuarantined(ep('1.1.1.1'))).toBe(false);
    });

    it('failure: returns backoff and doubles the interval', () => {
      const h = new EndpointHealth(cfg);
      h.quarantine(ep('1.1.1.1'), new Date(0));
      const outcome = h.recordRecheckResult(ep('1.1.1.1'), false, new Date(60_000));
      expect(outcome).toBe('backoff');
      expect(h.isQuarantined(ep('1.1.1.1'))).toBe(true);
      // Next check should be at 60_000ms (recheck time) + 120_000ms (doubled backoff)
      expect(h.getNextCheckAt(ep('1.1.1.1'))).toBe(60_000 + 120_000);
    });

    it('caps backoff at maxBackoffMs', () => {
      const h = new EndpointHealth({ initialBackoffMs: 1_800_000, maxBackoffMs: 3_600_000, multiplier: 2 });
      h.quarantine(ep('1.1.1.1'), new Date(0));
      h.recordRecheckResult(ep('1.1.1.1'), false, new Date(1_800_000));
      // 1_800_000 * 2 = 3_600_000 (at max)
      expect(h.getCurrentBackoffMs(ep('1.1.1.1'))).toBe(3_600_000);
      h.recordRecheckResult(ep('1.1.1.1'), false, new Date(5_400_000));
      // Should stay capped at max
      expect(h.getCurrentBackoffMs(ep('1.1.1.1'))).toBe(3_600_000);
    });
  });

  describe('getQuarantinedKeys()', () => {
    it('returns set of host:port strings', () => {
      const h = new EndpointHealth(cfg);
      h.quarantine(ep('1.1.1.1'), new Date());
      h.quarantine(ep('8.8.8.8', 443), new Date());
      const keys = h.getQuarantinedKeys();
      expect(keys.has('1.1.1.1:53')).toBe(true);
      expect(keys.has('8.8.8.8:443')).toBe(true);
    });
  });
});
