import { PingResult } from './pinger';

export type MonitorState = 'normal' | 'bulkhead' | 'outage';

export interface StateTransition {
  from: MonitorState;
  to: MonitorState;
  triggeredBy: PingResult;
  at: string;
}

export class StateMachine {
  private state: MonitorState = 'normal';
  private consecutiveSuccesses: number = 0;
  private readonly successesRequired: number;
  private readonly normalIntervalMs: number;
  private readonly outageIntervalMs: number;

  constructor(config: {
    consecutiveSuccessesForRecovery: number;
    normalIntervalMs: number;
    outageIntervalMs: number;
  }) {
    this.successesRequired = config.consecutiveSuccessesForRecovery;
    this.normalIntervalMs = config.normalIntervalMs;
    this.outageIntervalMs = config.outageIntervalMs;
  }

  // Called for each rotating single-probe result.
  // In 'normal': any failure immediately enters 'bulkhead'.
  // In 'outage': successes accumulate toward recovery.
  // In 'bulkhead': probe results are ignored — use processBulkheadResult instead.
  public process(result: PingResult): StateTransition | null {
    if (this.state === 'normal' && !result.success) {
      this.consecutiveSuccesses = 0;
      this.state = 'bulkhead';
      return { from: 'normal', to: 'bulkhead', triggeredBy: result, at: result.timestamp };
    }

    if (this.state === 'outage') {
      if (result.success) {
        this.consecutiveSuccesses++;
      } else {
        this.consecutiveSuccesses = 0;
      }

      if (this.consecutiveSuccesses >= this.successesRequired) {
        this.consecutiveSuccesses = 0;
        this.state = 'normal';
        return { from: 'outage', to: 'normal', triggeredBy: result, at: result.timestamp };
      }
    }

    return null;
  }

  // Called after blasting all endpoints during bulkhead check.
  // majorityFailed = more than half of all endpoints failed.
  public processBulkheadResult(majorityFailed: boolean, at: string): StateTransition {
    const from: MonitorState = 'bulkhead';
    const to: MonitorState = majorityFailed ? 'outage' : 'normal';
    this.consecutiveSuccesses = 0;
    this.state = to;
    return { from, to, triggeredBy: { success: !majorityFailed, latencyMs: null, host: '', port: 0, timestamp: at }, at };
  }

  public getState(): MonitorState {
    return this.state;
  }

  public getIntervalMs(): number {
    if (this.state === 'outage') return this.outageIntervalMs;
    return this.normalIntervalMs; // 'normal' and 'bulkhead' (transient)
  }
}
