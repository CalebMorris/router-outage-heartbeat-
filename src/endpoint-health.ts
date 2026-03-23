import { Endpoint } from './config';

interface QuarantineEntry {
  endpoint: Endpoint;
  quarantinedAt: string;
  backoffMs: number;
  nextCheckAt: number;
}

export interface QuarantinedEndpoint {
  endpoint: Endpoint;
  quarantinedAt: string;
  backoffMs: number;
  nextCheckAt: number;
}

export class EndpointHealth {
  private readonly map = new Map<string, QuarantineEntry>();
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly multiplier: number;

  constructor(config: {
    initialBackoffMs: number;
    maxBackoffMs: number;
    multiplier: number;
  }) {
    this.initialBackoffMs = config.initialBackoffMs;
    this.maxBackoffMs = config.maxBackoffMs;
    this.multiplier = config.multiplier;
  }

  private key(ep: Endpoint): string {
    return `${ep.host}:${ep.port}`;
  }

  public quarantine(ep: Endpoint, now: Date): void {
    const k = this.key(ep);
    if (this.map.has(k)) return; // already quarantined — no-op
    this.map.set(k, {
      endpoint: ep,
      quarantinedAt: now.toISOString(),
      backoffMs: this.initialBackoffMs,
      nextCheckAt: now.getTime() + this.initialBackoffMs,
    });
  }

  public isQuarantined(ep: Endpoint): boolean {
    return this.map.has(this.key(ep));
  }

  public getQuarantinedKeys(): Set<string> {
    return new Set(this.map.keys());
  }

  public size(): number {
    return this.map.size;
  }

  /** Returns the time (ms since epoch) when this endpoint is next due for recheck. */
  public getNextCheckAt(ep: Endpoint): number | null {
    return this.map.get(this.key(ep))?.nextCheckAt ?? null;
  }

  public getQuarantinedAt(ep: Endpoint): string | null {
    return this.map.get(this.key(ep))?.quarantinedAt ?? null;
  }

  public getCurrentBackoffMs(ep: Endpoint): number | null {
    return this.map.get(this.key(ep))?.backoffMs ?? null;
  }

  /** Returns all quarantined endpoints whose nextCheckAt <= now.getTime(). */
  public getDueForRecheck(now: Date): Endpoint[] {
    const nowMs = now.getTime();
    const due: Endpoint[] = [];
    for (const entry of this.map.values()) {
      if (entry.nextCheckAt <= nowMs) {
        due.push(entry.endpoint);
      }
    }
    return due;
  }

  /**
   * Record the result of a recheck probe.
   * - success: removes from quarantine, returns 'restored'
   * - failure: doubles backoff (capped at max), returns 'backoff'
   */
  public recordRecheckResult(ep: Endpoint, success: boolean, now: Date): 'restored' | 'backoff' {
    const k = this.key(ep);
    const entry = this.map.get(k);
    if (!entry) return 'restored'; // not quarantined — treat as restored

    if (success) {
      this.map.delete(k);
      return 'restored';
    }

    const newBackoff = Math.min(entry.backoffMs * this.multiplier, this.maxBackoffMs);
    entry.backoffMs = newBackoff;
    entry.nextCheckAt = now.getTime() + newBackoff;
    return 'backoff';
  }

  public getAll(): QuarantinedEndpoint[] {
    return Array.from(this.map.values());
  }
}
