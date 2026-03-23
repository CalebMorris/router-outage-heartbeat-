import { Endpoint } from './config';

export class EndpointRotator {
  private cursor: number = 0;

  constructor(private readonly endpoints: Endpoint[]) {
    if (endpoints.length === 0) {
      throw new Error('EndpointRotator requires at least one endpoint');
    }
  }

  public next(quarantined?: Set<string>): Endpoint {
    if (!quarantined || quarantined.size === 0) {
      const endpoint = this.endpoints[this.cursor];
      this.cursor = (this.cursor + 1) % this.endpoints.length;
      return endpoint;
    }

    // Find the next non-quarantined endpoint, advancing cursor past skipped ones.
    const total = this.endpoints.length;
    let found: Endpoint | null = null;
    for (let i = 0; i < total; i++) {
      const candidate = this.endpoints[this.cursor];
      this.cursor = (this.cursor + 1) % total;
      if (!quarantined.has(`${candidate.host}:${candidate.port}`)) {
        found = candidate;
        break;
      }
    }

    // Safety valve: if all endpoints are quarantined, fall back to unfiltered rotation.
    if (found === null) {
      const endpoint = this.endpoints[this.cursor];
      this.cursor = (this.cursor + 1) % total;
      return endpoint;
    }

    return found;
  }
}
