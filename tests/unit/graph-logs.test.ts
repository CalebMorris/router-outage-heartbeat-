import * as fs from 'fs';
import * as readline from 'readline';
import { parseArgs, main, mergeCloseOutageZones } from '../../scripts/graph-logs';

jest.mock('child_process', () => ({ execSync: jest.fn() }));
jest.mock('fs', () => ({
  existsSync: jest.fn(() => true),
  createReadStream: jest.fn(() => ({})),
  writeFileSync: jest.fn(),
}));
jest.mock('readline', () => ({ createInterface: jest.fn() }));

// Fake wall-clock for all Date.now() calls
const FAKE_NOW = new Date('2026-03-22T12:00:00.000Z');
// 24h before FAKE_NOW — what the buggy interval would have used as `since`
const FAKE_24H_AGO = '2026-03-21T12:00:00.000Z';
// A probe entry that falls AFTER the explicit --since (2026-03-20) but BEFORE 24h-ago (2026-03-21T12).
// With the correct fix it should appear in both renders; with the old bug it would be dropped on refresh.
const PROBE_IN_WINDOW = JSON.stringify({
  time: '2026-03-20T18:00:00.000Z',
  event: 'probe',
  host: '1.1.1.1',
  port: 53,
  success: true,
  latencyMs: 10,
  state: 'normal',
});

function setArgv(...args: string[]): void {
  process.argv = ['node', 'graph-logs.ts', ...args];
}

function makeReadlineInterface(lines: string[]): readline.Interface {
  return {
    [Symbol.asyncIterator]: (): AsyncIterator<string> => {
      let i = 0;
      return {
        next: async (): Promise<IteratorResult<string>> =>
          i < lines.length
            ? { done: false, value: lines[i++] }
            : { done: true, value: '' },
      };
    },
  } as unknown as readline.Interface;
}

describe('parseArgs', () => {
  const originalArgv = process.argv;

  beforeEach((): void => {
    jest.useFakeTimers({ now: FAKE_NOW });
  });

  afterEach((): void => {
    process.argv = originalArgv;
    jest.useRealTimers();
  });

  it('preserves explicit --since in live mode', (): void => {
    setArgv('--live', '--since', '2026-03-20', '--out', '/tmp/test.html');
    const { since, live } = parseArgs();
    expect(live).toBe(true);
    expect(since).not.toBeNull();
    expect(since!.toISOString().slice(0, 10)).toBe('2026-03-20');
  });

  it('defaults --since to 24h ago in live mode when not provided', (): void => {
    setArgv('--live', '--out', '/tmp/test.html');
    const { since } = parseArgs();
    expect(since).not.toBeNull();
    expect(since!.toISOString().slice(0, 10)).toBe('2026-03-21');
  });

  it('returns null since in non-live mode when not provided', (): void => {
    setArgv('--out', '/tmp/test.html');
    const { since } = parseArgs();
    expect(since).toBeNull();
  });

  it('preserves explicit --since in non-live mode', (): void => {
    setArgv('--since', '2026-01-15', '--out', '/tmp/test.html');
    const { since } = parseArgs();
    expect(since!.toISOString().slice(0, 10)).toBe('2026-01-15');
  });
});

describe('main — live mode since regression', () => {
  // Regression: the setInterval callback must close over the `since` captured from
  // parseArgs, not recompute `new Date(Date.now() - 24h)` on every tick.
  //
  // The test places a probe entry at 2026-03-20T18:00 — after explicit --since
  // (2026-03-20) but before the 24h-ago cutoff (2026-03-21T12:00 given FAKE_NOW).
  // With the correct fix the entry appears in both renders; with the old bug it
  // would be filtered out on the second (interval-triggered) render.
  const originalArgv = process.argv;

  beforeEach((): void => {
    jest.useFakeTimers({ now: FAKE_NOW });
    (readline.createInterface as jest.Mock).mockReturnValue(
      makeReadlineInterface([PROBE_IN_WINDOW]),
    );
  });

  afterEach((): void => {
    process.argv = originalArgv;
    jest.useRealTimers();
    (readline.createInterface as jest.Mock).mockReset();
    (fs.writeFileSync as jest.Mock).mockClear();
  });

  it('includes entries from explicit --since window on both initial render and interval refresh', async (): Promise<void> => {
    setArgv('--live', '--since', '2026-03-20', '--log', '/fake/log', '--out', '/tmp/test.html');

    await main();

    // Initial render — probe at 2026-03-20T18 should be present
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    const firstHtml = (fs.writeFileSync as jest.Mock).mock.calls[0][1] as string;
    expect(firstHtml).toContain('2026-03-20T18:00:00');

    // Advance to trigger the 60s refresh
    await jest.advanceTimersByTimeAsync(60_000);

    // Refresh render — same probe must still be present (bug: would be dropped if
    // the interval used 24h-ago = 2026-03-21T12:00 instead of since = 2026-03-20)
    expect(fs.writeFileSync).toHaveBeenCalledTimes(2);
    const secondHtml = (fs.writeFileSync as jest.Mock).mock.calls[1][1] as string;
    expect(secondHtml).toContain('2026-03-20T18:00:00');
    // Sanity-check: an entry before the explicit --since would be absent in both renders
    expect(secondHtml).not.toContain(FAKE_24H_AGO);
  });
});

describe('mergeCloseOutageZones', () => {
  const zone = (xMin: string, xMax: string, ongoing = false): { xMin: string; xMax: string; ongoing: boolean } =>
    ({ xMin, xMax, ongoing });

  it('returns empty array for empty input', (): void => {
    expect(mergeCloseOutageZones([])).toEqual([]);
  });

  it('returns single zone unchanged', (): void => {
    const input = [zone('2026-03-01T00:00:00.000Z', '2026-03-01T00:05:00.000Z')];
    expect(mergeCloseOutageZones(input)).toEqual(input);
  });

  it('merges two zones with gap < 1 minute', (): void => {
    const result = mergeCloseOutageZones([
      zone('2026-03-01T00:00:00.000Z', '2026-03-01T00:05:00.000Z'),
      zone('2026-03-01T00:05:30.000Z', '2026-03-01T00:10:00.000Z'),
    ]);
    expect(result).toEqual([zone('2026-03-01T00:00:00.000Z', '2026-03-01T00:10:00.000Z')]);
  });

  it('does not merge two zones with gap exactly 1 minute', (): void => {
    const result = mergeCloseOutageZones([
      zone('2026-03-01T00:00:00.000Z', '2026-03-01T00:05:00.000Z'),
      zone('2026-03-01T00:06:00.000Z', '2026-03-01T00:10:00.000Z'),
    ]);
    expect(result).toHaveLength(2);
  });

  it('does not merge two zones with gap > 1 minute', (): void => {
    const result = mergeCloseOutageZones([
      zone('2026-03-01T00:00:00.000Z', '2026-03-01T00:05:00.000Z'),
      zone('2026-03-01T00:10:00.000Z', '2026-03-01T00:15:00.000Z'),
    ]);
    expect(result).toHaveLength(2);
  });

  it('merges first two zones but not third when third gap is >= 1 minute', (): void => {
    const result = mergeCloseOutageZones([
      zone('2026-03-01T00:00:00.000Z', '2026-03-01T00:05:00.000Z'),
      zone('2026-03-01T00:05:30.000Z', '2026-03-01T00:10:00.000Z'),
      zone('2026-03-01T00:20:00.000Z', '2026-03-01T00:25:00.000Z'),
    ]);
    expect(result).toEqual([
      zone('2026-03-01T00:00:00.000Z', '2026-03-01T00:10:00.000Z'),
      zone('2026-03-01T00:20:00.000Z', '2026-03-01T00:25:00.000Z'),
    ]);
  });

  it('merges all three zones in a chain when each gap is < 1 minute', (): void => {
    const result = mergeCloseOutageZones([
      zone('2026-03-01T00:00:00.000Z', '2026-03-01T00:05:00.000Z'),
      zone('2026-03-01T00:05:30.000Z', '2026-03-01T00:10:00.000Z'),
      zone('2026-03-01T00:10:45.000Z', '2026-03-01T00:15:00.000Z'),
    ]);
    expect(result).toEqual([zone('2026-03-01T00:00:00.000Z', '2026-03-01T00:15:00.000Z')]);
  });

  it('propagates ongoing=true when any zone in merged group is ongoing', (): void => {
    const result = mergeCloseOutageZones([
      zone('2026-03-01T00:00:00.000Z', '2026-03-01T00:05:00.000Z', false),
      zone('2026-03-01T00:05:30.000Z', '2026-03-01T00:10:00.000Z', true),
    ]);
    expect(result[0].ongoing).toBe(true);
  });

  it('keeps ongoing=false when no zone in merged group is ongoing', (): void => {
    const result = mergeCloseOutageZones([
      zone('2026-03-01T00:00:00.000Z', '2026-03-01T00:05:00.000Z', false),
      zone('2026-03-01T00:05:30.000Z', '2026-03-01T00:10:00.000Z', false),
    ]);
    expect(result[0].ongoing).toBe(false);
  });
});
