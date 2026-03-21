import { Endpoint } from './config';

export class EndpointRotator {
  private cursor: number = 0;

  constructor(private readonly endpoints: Endpoint[]) {
    if (endpoints.length === 0) {
      throw new Error('EndpointRotator requires at least one endpoint');
    }
  }

  public next(): Endpoint {
    const endpoint = this.endpoints[this.cursor];
    this.cursor = (this.cursor + 1) % this.endpoints.length;
    return endpoint;
  }
}
