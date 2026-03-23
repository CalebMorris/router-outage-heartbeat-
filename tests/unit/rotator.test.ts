import { EndpointRotator } from '../../src/rotator';
import { Endpoint } from '../../src/config';

function ep(host: string, port = 53): Endpoint {
  return { host, port };
}

describe('EndpointRotator', () => {
  describe('normal round-robin', () => {
    it('cycles through all endpoints', () => {
      const endpoints = [ep('1.1.1.1'), ep('8.8.8.8'), ep('9.9.9.9')];
      const r = new EndpointRotator(endpoints);
      expect(r.next()).toEqual(ep('1.1.1.1'));
      expect(r.next()).toEqual(ep('8.8.8.8'));
      expect(r.next()).toEqual(ep('9.9.9.9'));
      expect(r.next()).toEqual(ep('1.1.1.1')); // wraps
    });
  });

  describe('with quarantined set', () => {
    it('skips quarantined endpoints', () => {
      const endpoints = [ep('1.1.1.1'), ep('8.8.8.8'), ep('9.9.9.9')];
      const r = new EndpointRotator(endpoints);
      const quarantined = new Set(['8.8.8.8:53']);
      expect(r.next(quarantined)).toEqual(ep('1.1.1.1'));
      expect(r.next(quarantined)).toEqual(ep('9.9.9.9')); // skips 8.8.8.8
      expect(r.next(quarantined)).toEqual(ep('1.1.1.1')); // wraps back
    });

    it('handles quarantined endpoint at wrap boundary', () => {
      const endpoints = [ep('1.1.1.1'), ep('8.8.8.8'), ep('9.9.9.9')];
      const r = new EndpointRotator(endpoints);
      const quarantined = new Set(['9.9.9.9:53']); // last one quarantined
      r.next(quarantined); // 1.1.1.1
      r.next(quarantined); // 8.8.8.8 (skips 9.9.9.9 at boundary)
      expect(r.next(quarantined)).toEqual(ep('1.1.1.1')); // wraps to start
    });

    it('falls back to unfiltered when all endpoints are quarantined (safety valve)', () => {
      const endpoints = [ep('1.1.1.1'), ep('8.8.8.8')];
      const r = new EndpointRotator(endpoints);
      const quarantined = new Set(['1.1.1.1:53', '8.8.8.8:53']);
      const result = r.next(quarantined);
      // Should return something (not throw)
      expect(result).toBeDefined();
      expect(result.host).toBeTruthy();
    });

    it('with 1 endpoint quarantined, safety valve returns it', () => {
      const endpoints = [ep('1.1.1.1')];
      const r = new EndpointRotator(endpoints);
      const quarantined = new Set(['1.1.1.1:53']);
      const result = r.next(quarantined);
      expect(result).toEqual(ep('1.1.1.1'));
    });
  });

  describe('empty constructor', () => {
    it('throws on empty endpoint list', () => {
      expect(() => new EndpointRotator([])).toThrow();
    });
  });
});
