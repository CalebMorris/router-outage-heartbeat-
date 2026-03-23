import { StateMachine } from '../../src/state-machine';
import { PingResult } from '../../src/pinger';

function makeResult(success: boolean, host = '1.1.1.1', port = 53): PingResult {
  return { success, latencyMs: success ? 10 : null, host, port, timestamp: new Date().toISOString() };
}

const testConfig = {
  consecutiveSuccessesForRecovery: 3,
  normalIntervalMs: 5_000,
  outageIntervalMs: 100,
};

describe('StateMachine', () => {
  describe('normal → bulkhead', () => {
    it('transitions on first failure', () => {
      const sm = new StateMachine(testConfig);
      const transition = sm.process(makeResult(false));
      expect(transition).not.toBeNull();
      expect(transition!.from).toBe('normal');
      expect(transition!.to).toBe('bulkhead');
      expect(sm.getState()).toBe('bulkhead');
    });

    it('does not transition on success in normal state', () => {
      const sm = new StateMachine(testConfig);
      expect(sm.process(makeResult(true))).toBeNull();
      expect(sm.getState()).toBe('normal');
    });
  });

  describe('bulkhead → outage', () => {
    it('enters outage when majority failed', () => {
      const sm = new StateMachine(testConfig);
      sm.process(makeResult(false)); // → bulkhead
      const t = sm.processBulkheadResult(true, new Date().toISOString());
      expect(t.to).toBe('outage');
      expect(sm.getState()).toBe('outage');
    });
  });

  describe('bulkhead → normal (false alarm)', () => {
    it('returns to normal when majority healthy', () => {
      const sm = new StateMachine(testConfig);
      sm.process(makeResult(false)); // → bulkhead
      const t = sm.processBulkheadResult(false, new Date().toISOString());
      expect(t.to).toBe('normal');
      expect(sm.getState()).toBe('normal');
    });
  });

  describe('outage recovery', () => {
    it('requires N consecutive successes to recover', () => {
      const sm = new StateMachine(testConfig); // N=3
      sm.process(makeResult(false));
      sm.processBulkheadResult(true, new Date().toISOString());
      expect(sm.getState()).toBe('outage');

      expect(sm.process(makeResult(true))).toBeNull(); // 1
      expect(sm.process(makeResult(true))).toBeNull(); // 2
      const t = sm.process(makeResult(true));          // 3 → recover
      expect(t).not.toBeNull();
      expect(t!.from).toBe('outage');
      expect(t!.to).toBe('normal');
      expect(sm.getState()).toBe('normal');
    });

    it('resets counter on failure during recovery', () => {
      const sm = new StateMachine(testConfig);
      sm.process(makeResult(false));
      sm.processBulkheadResult(true, new Date().toISOString());

      sm.process(makeResult(true)); // 1
      sm.process(makeResult(true)); // 2
      sm.process(makeResult(false)); // reset
      sm.process(makeResult(true)); // 1 again
      sm.process(makeResult(true)); // 2 again
      const t = sm.process(makeResult(true)); // 3 → recover
      expect(t).not.toBeNull();
      expect(t!.to).toBe('normal');
    });
  });

  describe('getIntervalMs', () => {
    it('returns normalIntervalMs in normal state', () => {
      const sm = new StateMachine(testConfig);
      expect(sm.getIntervalMs()).toBe(5_000);
    });

    it('returns outageIntervalMs in outage state', () => {
      const sm = new StateMachine(testConfig);
      sm.process(makeResult(false));
      sm.processBulkheadResult(true, new Date().toISOString());
      expect(sm.getIntervalMs()).toBe(100);
    });

    it('returns normalIntervalMs in bulkhead state (transient)', () => {
      const sm = new StateMachine(testConfig);
      sm.process(makeResult(false));
      expect(sm.getState()).toBe('bulkhead');
      expect(sm.getIntervalMs()).toBe(5_000);
    });
  });
});
