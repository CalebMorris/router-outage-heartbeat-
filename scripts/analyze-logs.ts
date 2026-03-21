import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';

const DEFAULT_LOG_PATH = path.join(
  os.homedir(),
  '.local',
  'share',
  'router-outage-heartbeat',
  'heartbeat.log',
);

interface ProbeEntry {
  time: string;
  event: 'probe';
  host: string;
  port: number;
  success: boolean;
  latencyMs: number | null;
  state: string;
}

interface OutageStartEntry {
  time: string;
  event: 'outage_start';
  host: string;
  port: number;
  outageStartedAt: string;
}

interface OutageEndEntry {
  time: string;
  event: 'outage_end';
  durationMs: number;
  outageStartedAt: string;
  outageEndedAt: string;
}

type LogEntry = ProbeEntry | OutageStartEntry | OutageEndEntry | { time: string; event: string; [key: string]: unknown };

interface OutageRecord {
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
}

function parseArgs(): { logPath: string; since: Date | null; format: 'text' | 'csv'; mode: 'request' | 'outage' | 'summary' } {
  const args = process.argv.slice(2);
  let logPath = DEFAULT_LOG_PATH;
  let since: Date | null = null;
  let format: 'text' | 'csv' = 'text';
  let mode: 'request' | 'outage' | 'summary' = 'summary';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--log' && args[i + 1]) {
      logPath = args[++i];
    } else if (args[i] === '--since' && args[i + 1]) {
      since = new Date(args[++i]);
    } else if (args[i] === '--format' && args[i + 1]) {
      const f = args[++i];
      if (f === 'csv' || f === 'text') format = f;
    } else if (args[i] === '--mode' && args[i + 1]) {
      const m = args[++i];
      if (m === 'request' || m === 'outage' || m === 'summary') mode = m;
    }
  }

  return { logPath, since, format, mode };
}

async function readEntries(logPath: string, since: Date | null): Promise<LogEntry[]> {
  const entries: LogEntry[] = [];

  if (!fs.existsSync(logPath)) {
    console.error(`Log file not found: ${logPath}`);
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(logPath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as LogEntry;
      if (since && new Date(entry.time) < since) continue;
      entries.push(entry);
    } catch {
      // skip malformed lines (e.g., logrotate boundary corruption)
    }
  }

  return entries;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

function printRequestMode(entries: LogEntry[], format: 'text' | 'csv'): void {
  const probes = entries.filter((e): e is ProbeEntry => e.event === 'probe');

  if (format === 'csv') {
    console.log('timestamp,host,port,success,latencyMs,state');
    for (const p of probes) {
      console.log(`${p.time},${p.host},${p.port},${p.success},${p.latencyMs ?? ''},${p.state}`);
    }
    return;
  }

  console.log('Request Logs');
  console.log('============');
  console.log(`${'Timestamp'.padEnd(32)} ${'Endpoint'.padEnd(26)} ${'Result'.padEnd(8)} Latency`);
  console.log('-'.repeat(80));
  for (const p of probes) {
    const endpoint = `${p.host}:${p.port}`.padEnd(26);
    const result = p.success ? 'OK' : 'FAIL';
    const latency = p.latencyMs !== null ? `${p.latencyMs.toFixed(1)}ms` : '-';
    console.log(`${p.time.padEnd(32)} ${endpoint} ${result.padEnd(8)} ${latency}`);
  }
}

function printOutageMode(entries: LogEntry[], format: 'text' | 'csv'): void {
  const probes = entries.filter(
    (e): e is ProbeEntry => e.event === 'probe' && (e as ProbeEntry).state === 'outage',
  );

  if (format === 'csv') {
    console.log('timestamp,host,port,success,latencyMs');
    for (const p of probes) {
      console.log(`${p.time},${p.host},${p.port},${p.success},${p.latencyMs ?? ''}`);
    }
    return;
  }

  console.log('Outage Period Probe Logs');
  console.log('========================');
  console.log(`${'Timestamp'.padEnd(32)} ${'Endpoint'.padEnd(26)} ${'Result'.padEnd(8)} Latency`);
  console.log('-'.repeat(80));
  for (const p of probes) {
    const endpoint = `${p.host}:${p.port}`.padEnd(26);
    const result = p.success ? 'OK' : 'FAIL';
    const latency = p.latencyMs !== null ? `${p.latencyMs.toFixed(1)}ms` : '-';
    console.log(`${p.time.padEnd(32)} ${endpoint} ${result.padEnd(8)} ${latency}`);
  }
}

function printSummaryMode(entries: LogEntry[], format: 'text' | 'csv'): void {
  const outages: OutageRecord[] = [];
  const startMap = new Map<string, string>();

  for (const entry of entries) {
    if (entry.event === 'outage_start') {
      const e = entry as OutageStartEntry;
      startMap.set(e.outageStartedAt, e.outageStartedAt);
    } else if (entry.event === 'outage_end') {
      const e = entry as OutageEndEntry;
      outages.push({
        startedAt: e.outageStartedAt,
        endedAt: e.outageEndedAt,
        durationMs: e.durationMs,
      });
      startMap.delete(e.outageStartedAt);
    }
  }

  // Any outage_start without matching outage_end (ongoing)
  for (const [startedAt] of startMap) {
    outages.push({ startedAt, endedAt: null, durationMs: null });
  }

  outages.sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());

  const completed = outages.filter((o): o is OutageRecord & { durationMs: number } => o.durationMs !== null);
  const totalMs = completed.reduce((sum, o) => sum + o.durationMs, 0);
  const durations = completed.map((o) => o.durationMs);
  const minMs = durations.length > 0 ? Math.min(...durations) : 0;
  const maxMs = durations.length > 0 ? Math.max(...durations) : 0;
  const meanMs = durations.length > 0 ? totalMs / durations.length : 0;

  // Most common hour
  const hourCounts = new Map<number, number>();
  for (const o of outages) {
    const hour = new Date(o.startedAt).getHours();
    hourCounts.set(hour, (hourCounts.get(hour) ?? 0) + 1);
  }
  let mostCommonHour: number | null = null;
  let mostCommonCount = 0;
  for (const [hour, count] of hourCounts) {
    if (count > mostCommonCount) {
      mostCommonHour = hour;
      mostCommonCount = count;
    }
  }

  if (format === 'csv') {
    console.log('started_at,ended_at,duration_ms,duration_human');
    for (const o of outages) {
      const dur = o.durationMs !== null ? o.durationMs.toString() : '';
      const durHuman = o.durationMs !== null ? formatDuration(o.durationMs) : 'ongoing';
      console.log(`${o.startedAt},${o.endedAt ?? ''},${dur},${durHuman}`);
    }
    return;
  }

  console.log('Outage Summary Report');
  console.log('=====================');
  console.log(`Total outages:    ${outages.length}`);
  console.log(`Completed:        ${completed.length}`);
  console.log(`Total downtime:   ${formatDuration(totalMs)}`);
  if (completed.length > 0) {
    console.log(`Mean duration:    ${formatDuration(meanMs)}`);
    console.log(`Min duration:     ${formatDuration(minMs)}`);
    console.log(`Max duration:     ${formatDuration(maxMs)}`);
  }
  if (mostCommonHour !== null) {
    console.log(`Most common hour: ${mostCommonHour}:00–${mostCommonHour + 1}:00 (${mostCommonCount} outages)`);
  }
  console.log('');
  console.log(`${'#'.padEnd(4)} ${'Started At'.padEnd(32)} ${'Ended At'.padEnd(32)} Duration`);
  console.log('-'.repeat(80));
  outages.forEach((o, i) => {
    const endedAt = o.endedAt ?? '(ongoing)';
    const duration = o.durationMs !== null ? formatDuration(o.durationMs) : 'ongoing';
    console.log(`${String(i + 1).padEnd(4)} ${o.startedAt.padEnd(32)} ${endedAt.padEnd(32)} ${duration}`);
  });
}

async function main(): Promise<void> {
  const { logPath, since, format, mode } = parseArgs();
  const entries = await readEntries(logPath, since);

  if (mode === 'request') {
    printRequestMode(entries, format);
  } else if (mode === 'outage') {
    printOutageMode(entries, format);
  } else {
    printSummaryMode(entries, format);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
