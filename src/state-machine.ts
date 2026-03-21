import { PingResult } from './pinger';

export type MonitorState = 'normal' | 'outage';

export interface StateTransition {
  from: MonitorState;
  to: MonitorState;
  triggeredBy: PingResult;
  at: string;
}

export class StateMachine {
  private state: MonitorState = 'normal';
  private consecutiveFailures: number = 0;
  private consecutiveSuccesses: number = 0;
  private readonly failuresRequired: number;
  private readonly successesRequired: number;
  private readonly normalIntervalMs: number;
  private readonly outageIntervalMs: number;

  constructor(config: {
    consecutiveFailuresForOutage: number;
    consecutiveSuccessesForRecovery: number;
    normalIntervalMs: number;
    outageIntervalMs: number;
  }) {
    this.failuresRequired = config.consecutiveFailuresForOutage;
    this.successesRequired = config.consecutiveSuccessesForRecovery;
    this.normalIntervalMs = config.normalIntervalMs;
    this.outageIntervalMs = config.outageIntervalMs;
  }

  public process(result: PingResult): StateTransition | null {
    if (result.success) {
      this.consecutiveFailures = 0;
      this.consecutiveSuccesses++;
    } else {
      this.consecutiveSuccesses = 0;
      this.consecutiveFailures++;
    }

    const prevState = this.state;

    if (this.state === 'normal' && this.consecutiveFailures >= this.failuresRequired) {
      this.state = 'outage';
    } else if (this.state === 'outage' && this.consecutiveSuccesses >= this.successesRequired) {
      this.state = 'normal';
    }

    if (this.state !== prevState) {
      return {
        from: prevState,
        to: this.state,
        triggeredBy: result,
        at: result.timestamp,
      };
    }

    return null;
  }

  public getState(): MonitorState {
    return this.state;
  }

  public getIntervalMs(): number {
    return this.state === 'outage' ? this.outageIntervalMs : this.normalIntervalMs;
  }
}
