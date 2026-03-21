import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { execSync } from 'child_process';

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

interface OutageZone {
  xMin: string;
  xMax: string;
  ongoing: boolean;
}

interface Args {
  logPath: string;
  since: Date | null;
  outPath: string;
  open: boolean;
  live: boolean;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let logPath = DEFAULT_LOG_PATH;
  let since: Date | null = null;
  let outPath = '';
  let open = false;
  let live = false;
  let explicitSince = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--log' && args[i + 1]) {
      logPath = args[++i];
    } else if (args[i] === '--since' && args[i + 1]) {
      const parsed = new Date(args[++i]);
      if (isNaN(parsed.getTime())) {
        console.error(`Invalid --since date: "${args[i]}". Expected ISO format, e.g. 2026-03-01`);
        process.exit(1);
      }
      since = parsed;
      explicitSince = true;
    } else if (args[i] === '--out' && args[i + 1]) {
      outPath = args[++i];
    } else if (args[i] === '--open') {
      open = true;
    } else if (args[i] === '--live') {
      live = true;
    }
  }

  if (live) {
    if (!explicitSince) since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    if (!outPath) outPath = '/tmp/heartbeat-live.html';
    open = true;
  } else {
    if (!outPath) outPath = path.join(process.cwd(), 'heartbeat-graph.html');
  }

  return { logPath, since, outPath, open, live };
}

async function readEntries(
  logPath: string,
  since: Date | null,
): Promise<{ entries: LogEntry[]; skippedLines: number }> {
  const entries: LogEntry[] = [];
  let skippedLines = 0;

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
      skippedLines++;
    }
  }

  return { entries, skippedLines };
}

function buildDatasets(entries: LogEntry[]): {
  successPoints: { x: string; y: number; host: string; port: number }[];
  failurePoints: { x: string; y: number; host: string; port: number }[];
  outageZones: OutageZone[];
} {
  const successPoints: { x: string; y: number; host: string; port: number }[] = [];
  const failurePoints: { x: string; y: number; host: string; port: number }[] = [];
  const outageZones: OutageZone[] = [];
  const pendingStarts = new Map<string, string>();

  for (const entry of entries) {
    if (entry.event === 'probe') {
      const p = entry as ProbeEntry;
      if (p.success && p.latencyMs !== null) {
        successPoints.push({ x: p.time, y: p.latencyMs, host: p.host, port: p.port });
      } else if (!p.success) {
        failurePoints.push({ x: p.time, y: 0, host: p.host, port: p.port });
      }
    } else if (entry.event === 'outage_start') {
      const e = entry as OutageStartEntry;
      pendingStarts.set(e.outageStartedAt, e.outageStartedAt);
    } else if (entry.event === 'outage_end') {
      const e = entry as OutageEndEntry;
      pendingStarts.delete(e.outageStartedAt);
      outageZones.push({ xMin: e.outageStartedAt, xMax: e.outageEndedAt, ongoing: false });
    }
  }

  // Any unclosed outage_start events are ongoing
  for (const [startedAt] of pendingStarts) {
    outageZones.push({ xMin: startedAt, xMax: new Date().toISOString(), ongoing: true });
  }

  return { successPoints, failurePoints, outageZones };
}

function buildHtml(params: {
  successPoints: { x: string; y: number }[];
  failurePoints: { x: string; y: number }[];
  outageZones: OutageZone[];
  since: Date | null;
  generatedAt: string;
  live: boolean;
}): string {
  const { successPoints, failurePoints, outageZones, since, generatedAt, live } = params;
  const sinceText = since ? `since ${since.toISOString().slice(0, 10)}` : 'all time';
  const totalProbes = successPoints.length + failurePoints.length;
  const emptyNotice = totalProbes === 0
    ? `<p class="empty-notice">No probe data found for the selected time range.</p>`
    : '';

  const outageZonesJson = JSON.stringify(outageZones);
  const successJson = JSON.stringify(successPoints);
  const failureJson = JSON.stringify(failurePoints);
  const metaRefresh = live ? `\n  <meta http-equiv="refresh" content="60">` : '';
  const metaLine = live
    ? `Live · last 24h · updated ${generatedAt.slice(11, 19)} UTC &middot; ${totalProbes.toLocaleString()} probes &middot; ${outageZones.length} outage(s)`
    : `Generated: ${generatedAt} &middot; ${sinceText} &middot; ${totalProbes.toLocaleString()} probes &middot; ${outageZones.length} outage(s)`;
  const title = live ? 'Heartbeat — Live' : `Heartbeat Graph — ${sinceText}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">${metaRefresh}
  <title>${title}</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
  <script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0f172a; color: #e2e8f0; font-family: system-ui, sans-serif; padding: 24px; }
    h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: 6px; }
    .meta { font-size: 0.8rem; color: #94a3b8; margin-bottom: 20px; }
    .chart-container { position: relative; width: 100%; height: 480px; }
    .empty-notice { color: #f87171; font-size: 0.9rem; margin-bottom: 16px; }
  </style>
</head>
<body>
  <h1>Router Outage Heartbeat</h1>
  <p class="meta">${metaLine}</p>
  ${emptyNotice}
  <div class="chart-container">
    <canvas id="chart"></canvas>
  </div>
  <script>
    const outageZones = ${outageZonesJson};
    const outageBandsPlugin = {
      id: 'outageBands',
      beforeDraw(chart) {
        if (!outageZones.length) return;
        const { ctx, chartArea, scales } = chart;
        ctx.save();
        ctx.fillStyle = 'rgba(239, 68, 68, 0.15)';
        for (const zone of outageZones) {
          const x1 = Math.max(scales.x.getPixelForValue(new Date(zone.xMin).getTime()), chartArea.left);
          const x2 = Math.min(scales.x.getPixelForValue(new Date(zone.xMax).getTime()), chartArea.right);
          if (x2 <= x1) continue;
          ctx.fillRect(x1, chartArea.top, x2 - x1, chartArea.height);
          ctx.strokeStyle = 'rgba(239, 68, 68, 0.5)';
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(x1, chartArea.top); ctx.lineTo(x1, chartArea.bottom); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(x2, chartArea.top); ctx.lineTo(x2, chartArea.bottom); ctx.stroke();
        }
        ctx.restore();
      },
    };
    Chart.register(outageBandsPlugin);
    const ctx = document.getElementById('chart').getContext('2d');
    new Chart(ctx, {
      type: 'scatter',
      data: {
        datasets: [
          {
            label: 'Latency (ms)',
            data: ${successJson},
            backgroundColor: 'rgba(59, 130, 246, 0.65)',
            pointRadius: 3,
            pointHoverRadius: 5,
          },
          {
            label: 'Failure',
            data: ${failureJson},
            backgroundColor: 'rgba(239, 68, 68, 0.85)',
            pointRadius: 4,
            pointHoverRadius: 6,
            pointStyle: 'crossRot',
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        scales: {
          x: {
            type: 'time',
            time: {
              tooltipFormat: 'MMM d, HH:mm:ss',
              displayFormats: {
                millisecond: 'HH:mm:ss',
                second: 'HH:mm:ss',
                minute: 'HH:mm',
                hour: 'MMM d HH:mm',
                day: 'MMM d',
                week: 'MMM d',
                month: 'MMM yyyy',
              },
            },
            title: { display: true, text: 'Time', color: '#94a3b8' },
            ticks: { color: '#94a3b8', maxRotation: 30 },
            grid: { color: 'rgba(148,163,184,0.1)' },
          },
          y: {
            min: 0,
            title: { display: true, text: 'Latency (ms)', color: '#94a3b8' },
            ticks: { color: '#94a3b8' },
            grid: { color: 'rgba(148,163,184,0.1)' },
          },
        },
        plugins: {
          legend: {
            display: true,
            labels: { color: '#e2e8f0', pointStyle: 'circle', usePointStyle: true },
          },
          tooltip: {
            callbacks: {
              label: function(ctx) {
                const endpoint = ctx.raw.host + ':' + ctx.raw.port;
                if (ctx.datasetIndex === 1) return endpoint + ' — failed';
                return endpoint + ' — ' + ctx.parsed.y.toFixed(1) + ' ms';
              },
            },
          },
          outageBands: {},
        },
      },
    });
  </script>
</body>
</html>`;
}

async function generate(logPath: string, since: Date | null, outPath: string, live: boolean): Promise<void> {
  const { entries, skippedLines } = await readEntries(logPath, since);

  if (skippedLines > 0) {
    console.error(`Warning: ${skippedLines} malformed line(s) skipped.`);
  }

  const { successPoints, failurePoints, outageZones } = buildDatasets(entries);
  const html = buildHtml({
    successPoints,
    failurePoints,
    outageZones,
    since,
    generatedAt: new Date().toISOString(),
    live,
  });

  try {
    fs.writeFileSync(outPath, html, 'utf8');
  } catch (err) {
    console.error(`Failed to write output file: ${outPath}`);
    console.error(err);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const { logPath, since, outPath, open, live } = parseArgs();

  await generate(logPath, since, outPath, live);
  console.log(outPath);

  if (open) {
    try {
      execSync(`xdg-open ${JSON.stringify(outPath)}`);
    } catch {
      console.error('Warning: xdg-open failed — open the file manually in your browser.');
    }
  }

  if (live) {
    console.log('Watching — regenerating every 60s. Press Ctrl+C to stop.');
    setInterval((): void => {
      const liveSince = new Date(Date.now() - 24 * 60 * 60 * 1000);
      generate(logPath, liveSince, outPath, true).catch((err: unknown) => {
        console.error('Regeneration failed:', err);
      });
    }, 60_000);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
