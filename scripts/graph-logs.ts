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

interface BulkheadCheckEntry {
  time: string;
  event: 'bulkhead_check';
  totalEndpoints: number;
  failedCount: number;
  majorityFailed: boolean;
  failedEndpoints?: Array<{ host: string; port: number }>;
}

type LogEntry = ProbeEntry | OutageStartEntry | OutageEndEntry | BulkheadCheckEntry | EndpointQuarantinedEntry | EndpointRestoredEntry | { time: string; event: string; [key: string]: unknown };

interface OutageZone {
  xMin: string;
  xMax: string;
  ongoing: boolean;
}

interface PartialFailureZone {
  xMin: string;
  xMax: string;
  failedCount: number;
  totalEndpoints: number;
  failedEndpoints: Array<{ host: string; port: number }>;
}

interface QuarantineZone {
  host: string;
  port: number;
  quarantinedAt: string;
  restoredAt: string | null; // null = still quarantined
}

interface EndpointQuarantinedEntry {
  time: string;
  event: 'endpoint_quarantined';
  host: string;
  port: number;
  backoffMs: number;
}

interface EndpointRestoredEntry {
  time: string;
  event: 'endpoint_restored';
  host: string;
  port: number;
  quarantinedAt: string;
  restoredAt: string;
  durationMs: number;
}

interface Args {
  logPath: string;
  since: Date | null;
  outPath: string;
  open: boolean;
  live: boolean;
}

export function parseArgs(): Args {
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
  partialFailureZones: PartialFailureZone[];
  quarantineZones: QuarantineZone[];
} {
  const successPoints: { x: string; y: number; host: string; port: number }[] = [];
  const failurePoints: { x: string; y: number; host: string; port: number }[] = [];
  const outageZones: OutageZone[] = [];
  const partialFailureZones: PartialFailureZone[] = [];
  const quarantineMap = new Map<string, QuarantineZone>();
  const pendingStarts = new Map<string, string>();

  for (const entry of entries) {
    if (entry.event === 'probe') {
      const p = entry as ProbeEntry;
      if (p.success && p.latencyMs !== null) {
        successPoints.push({ x: p.time, y: p.latencyMs, host: p.host, port: p.port });
      } else if (!p.success) {
        failurePoints.push({ x: p.time, y: 0.5, host: p.host, port: p.port });
      }
    } else if (entry.event === 'outage_start') {
      const e = entry as OutageStartEntry;
      pendingStarts.set(e.outageStartedAt, e.outageStartedAt);
    } else if (entry.event === 'outage_end') {
      const e = entry as OutageEndEntry;
      pendingStarts.delete(e.outageStartedAt);
      outageZones.push({ xMin: e.outageStartedAt, xMax: e.outageEndedAt, ongoing: false });
    } else if (entry.event === 'bulkhead_check') {
      const e = entry as BulkheadCheckEntry;
      if (!e.majorityFailed && e.failedCount > 0) {
        partialFailureZones.push({ xMin: e.time, xMax: e.time, failedCount: e.failedCount, totalEndpoints: e.totalEndpoints, failedEndpoints: e.failedEndpoints ?? [] });
      }
    } else if (entry.event === 'endpoint_quarantined') {
      const e = entry as EndpointQuarantinedEntry;
      const key = `${e.host}:${e.port}:${e.time}`;
      quarantineMap.set(key, { host: e.host, port: e.port, quarantinedAt: e.time, restoredAt: null });
    } else if (entry.event === 'endpoint_restored') {
      const e = entry as EndpointRestoredEntry;
      // Match to the most recent open quarantine entry for this endpoint
      let matchKey: string | null = null;
      let matchTime = '';
      for (const [k, z] of quarantineMap) {
        if (z.host === e.host && z.port === e.port && z.restoredAt === null) {
          if (z.quarantinedAt > matchTime) { matchTime = z.quarantinedAt; matchKey = k; }
        }
      }
      if (matchKey !== null) {
        quarantineMap.get(matchKey)!.restoredAt = e.restoredAt;
      }
    }
  }

  // Any unclosed outage_start events are ongoing
  for (const [startedAt] of pendingStarts) {
    outageZones.push({ xMin: startedAt, xMax: new Date().toISOString(), ongoing: true });
  }

  const quarantineZones = Array.from(quarantineMap.values());
  return { successPoints, failurePoints, outageZones: mergeCloseOutageZones(outageZones), partialFailureZones, quarantineZones };
}

export function mergeCloseOutageZones(zones: OutageZone[]): OutageZone[] {
  if (zones.length === 0) return [];
  const sorted = [...zones].sort((a, b) => a.xMin.localeCompare(b.xMin));
  const merged: OutageZone[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const gap = new Date(sorted[i].xMin).getTime() - new Date(last.xMax).getTime();
    if (gap < 60_000) {
      last.xMax = sorted[i].xMax;
      last.ongoing = last.ongoing || sorted[i].ongoing;
    } else {
      merged.push({ ...sorted[i] });
    }
  }
  return merged;
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM > 0 ? `${h}h ${remM}m` : `${h}h`;
}

function buildHtml(params: {
  successPoints: { x: string; y: number }[];
  failurePoints: { x: string; y: number }[];
  outageZones: OutageZone[];
  partialFailureZones: PartialFailureZone[];
  quarantineZones: QuarantineZone[];
  since: Date | null;
  generatedAt: string;
  live: boolean;
}): string {
  const { successPoints, failurePoints, outageZones, partialFailureZones, quarantineZones, since, generatedAt, live } = params;
  const sinceText = since ? `since ${since.toISOString().slice(0, 10)}` : 'all time';

  const outageListHtml = outageZones.length === 0 ? '' : (() => {
    const sorted = [...outageZones].sort(
      (a, b) => new Date(b.xMin).getTime() - new Date(a.xMin).getTime(),
    );
    const rows = sorted.map((z) => {
      const start = new Date(z.xMin);
      const durationStr = z.ongoing
        ? `ongoing (~${formatDuration(Date.now() - start.getTime())} so far)`
        : formatDuration(new Date(z.xMax).getTime() - new Date(z.xMin).getTime());
      const durationClass = z.ongoing ? 'ongoing' : '';
      return `      <tr data-xmin="${z.xMin}"><td class="outage-start" data-iso="${z.xMin}"></td><td class="duration ${durationClass}">${durationStr}</td></tr>`;
    }).join('\n');
    return `
  <section class="outage-list">
    <h2>Outages (${outageZones.length})</h2>
    <table>
      <thead><tr><th>Start</th><th>Duration</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </section>
  <script>document.querySelectorAll('.outage-start[data-iso]').forEach(function(el){el.textContent=new Date(el.dataset.iso).toLocaleString();});<\/script>`;
  })();
  const degradedListHtml = partialFailureZones.length === 0 ? '' : (() => {
    const sorted = [...partialFailureZones].sort(
      (a, b) => new Date(b.xMin).getTime() - new Date(a.xMin).getTime(),
    );
    const rows = sorted.map((z) => {
      const endpointList = z.failedEndpoints.length > 0
        ? z.failedEndpoints.map((ep) => `${ep.host}:${ep.port}`).join(', ')
        : '';
      const endpointCell = endpointList ? `<td class="failed-endpoints">${endpointList}</td>` : '<td></td>';
      return `      <tr data-xmin="${z.xMin}"><td class="degraded-time" data-iso="${z.xMin}"></td><td class="failed-count">${z.failedCount}/${z.totalEndpoints}</td>${endpointCell}</tr>`;
    }).join('\n');
    return `
  <section class="degraded-list">
    <h2>Degraded Checks (${partialFailureZones.length})</h2>
    <table>
      <thead><tr><th>Time</th><th>Failed</th><th>Endpoints</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </section>
  <script>document.querySelectorAll('.degraded-time[data-iso]').forEach(function(el){el.textContent=new Date(el.dataset.iso).toLocaleString();});<\/script>`;
  })();

  const unhealthyEndpoints = quarantineZones.filter((z) => z.restoredAt === null)
    .sort((a, b) => new Date(b.quarantinedAt).getTime() - new Date(a.quarantinedAt).getTime());
  const endpointHealthHtml = unhealthyEndpoints.length === 0 ? '' : (() => {
    const rows = unhealthyEndpoints.map((z) => {
      return `      <tr><td class="quarantine-endpoint">${z.host}:${z.port}</td><td class="quarantine-time" data-iso="${z.quarantinedAt}"></td><td class="quarantine-duration quarantine-ongoing" data-quarantined-at="${z.quarantinedAt}"></td></tr>`;
    }).join('\n');
    return `
  <section class="quarantine-list">
    <h2>Unhealthy Endpoints (${unhealthyEndpoints.length})</h2>
    <table>
      <thead><tr><th>Endpoint</th><th>Quarantined At</th><th>For</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </section>
  <script>
    document.querySelectorAll('.quarantine-time[data-iso]').forEach(function(el){el.textContent=new Date(el.dataset.iso).toLocaleString();});
    document.querySelectorAll('.quarantine-duration[data-quarantined-at]').forEach(function(el){
      function tick(){var ms=Date.now()-new Date(el.dataset.quarantinedAt).getTime();var s=Math.floor(ms/1000),m=Math.floor(s/60),h=Math.floor(m/60);el.textContent=h>0?(h+'h '+(m%60>0?m%60+'m':'')):m>0?(m+'m '+(s%60>0?s%60+'s':'')):s+'s';}
      tick(); setInterval(tick,10000);
    });
  <\/script>`;
  })();

  const legendHtml = `
  <div class="chart-legend">
    <span><span class="chart-legend-swatch" style="background:rgba(239,68,68,0.4);border:1px solid rgba(239,68,68,0.7);"></span>Outage</span>
    <span><span class="chart-legend-swatch" style="background:rgba(234,179,8,0.25);border:1px solid rgba(234,179,8,0.7);"></span>Degraded</span>
  </div>`;

  const totalProbes = successPoints.length + failurePoints.length;
  const emptyNotice = totalProbes === 0
    ? `<p class="empty-notice">No probe data found for the selected time range.</p>`
    : '';

  const outageZonesJson = JSON.stringify(outageZones);
  const partialFailureZonesJson = JSON.stringify(partialFailureZones);
  const successJson = JSON.stringify(successPoints);
  const failureJson = JSON.stringify(failurePoints);
  const metaRefresh = live ? `\n  <meta http-equiv="refresh" content="60">` : '';
  const totalOutageMs = outageZones.reduce((sum, z) => {
    const end = z.ongoing ? Date.now() : new Date(z.xMax).getTime();
    return sum + (end - new Date(z.xMin).getTime());
  }, 0);
  const totalOutageSuffix = outageZones.length > 0
    ? ` &middot; ${formatDuration(totalOutageMs)} total`
    : '';
  const metaLine = live
    ? `Live · last 24h · updated ${generatedAt.slice(11, 19)} UTC &middot; ${totalProbes.toLocaleString()} probes &middot; ${outageZones.length} outage(s)${totalOutageSuffix}`
    : `Generated: ${generatedAt} &middot; ${sinceText} &middot; ${totalProbes.toLocaleString()} probes &middot; ${outageZones.length} outage(s)${totalOutageSuffix}`;
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
    .lists-row { display: flex; gap: 40px; margin-top: 32px; align-items: flex-start; }
    .outage-list { }
    .outage-list h2 { font-size: 1rem; font-weight: 600; margin-bottom: 10px; color: #e2e8f0; }
    .outage-list table { border-collapse: collapse; font-size: 0.85rem; width: auto; }
    .outage-list th { text-align: left; padding: 4px 16px 4px 0; color: #94a3b8; font-weight: 500; border-bottom: 1px solid rgba(148,163,184,0.2); }
    .outage-list td { padding: 5px 16px 5px 0; color: #e2e8f0; border-bottom: 1px solid rgba(148,163,184,0.08); }
    .duration { font-variant-numeric: tabular-nums; }
    .ongoing { color: #f87171; }
    .outage-list tbody tr.hovered { background: rgba(239,68,68,0.15); outline: 1px solid rgba(239,68,68,0.5); }
    .degraded-list { }
    .degraded-list h2 { font-size: 1rem; font-weight: 600; margin-bottom: 10px; color: #e2e8f0; }
    .degraded-list table { border-collapse: collapse; font-size: 0.85rem; width: auto; }
    .degraded-list th { text-align: left; padding: 4px 16px 4px 0; color: #94a3b8; font-weight: 500; border-bottom: 1px solid rgba(148,163,184,0.2); }
    .degraded-list td { padding: 5px 16px 5px 0; color: #e2e8f0; border-bottom: 1px solid rgba(148,163,184,0.08); }
    .degraded-list .failed-count { color: #eab308; font-variant-numeric: tabular-nums; }
    .degraded-list .failed-endpoints { color: #94a3b8; font-size: 0.8rem; font-family: monospace; }
    .degraded-list tbody tr.hovered { background: rgba(234,179,8,0.15); outline: 1px solid rgba(234,179,8,0.5); }
    .chart-legend { display: flex; gap: 20px; margin-top: 12px; font-size: 0.8rem; color: #94a3b8; align-items: center; }
    .chart-legend-swatch { display: inline-block; width: 16px; height: 12px; border-radius: 2px; margin-right: 5px; vertical-align: middle; }
    .quarantine-list { }
    .quarantine-list h2 { font-size: 1rem; font-weight: 600; margin-bottom: 10px; color: #e2e8f0; }
    .quarantine-list table { border-collapse: collapse; font-size: 0.85rem; width: auto; }
    .quarantine-list th { text-align: left; padding: 4px 16px 4px 0; color: #94a3b8; font-weight: 500; border-bottom: 1px solid rgba(148,163,184,0.2); }
    .quarantine-list td { padding: 5px 16px 5px 0; color: #e2e8f0; border-bottom: 1px solid rgba(148,163,184,0.08); }
    .quarantine-endpoint { font-family: monospace; font-size: 0.8rem; color: #94a3b8; }
    .quarantine-ongoing { color: #f59e0b; }
    .quarantine-duration { font-variant-numeric: tabular-nums; }
  </style>
</head>
<body>
  <h1>Router Outage Heartbeat</h1>
  <p class="meta">${metaLine}</p>
  ${emptyNotice}
  <div class="chart-container">
    <canvas id="chart"></canvas>
  </div>
  ${legendHtml}
  <div id="outage-tooltip" style="display:none;position:fixed;background:#1e293b;border:1px solid rgba(239,68,68,0.5);color:#e2e8f0;padding:8px 12px;border-radius:6px;font-size:13px;pointer-events:none;z-index:100;line-height:1.6;"></div>
  <div class="lists-row">
    ${outageListHtml}
    ${degradedListHtml}
    ${endpointHealthHtml}
  </div>
  <script>
    const outageZones = ${outageZonesJson};
    const partialFailureZones = ${partialFailureZonesJson};
    function fmtDur(ms) {
      const s = Math.floor(ms / 1000);
      if (s < 60) return s + 's';
      const m = Math.floor(s / 60), rs = s % 60;
      if (m < 60) return m + 'm ' + (rs > 0 ? rs + 's' : '');
      const h = Math.floor(m / 60), rm = m % 60;
      return h + 'h ' + (rm > 0 ? rm + 'm' : '');
    }
    let hoveredZone = null;
    let hoveredPartialZone = null;
    const outageBandsPlugin = {
      id: 'outageBands',
      beforeDraw(chart) {
        const { ctx, chartArea, scales } = chart;
        // Pass 1: yellow partial-failure bands (drawn first, under red)
        if (partialFailureZones.length) {
          ctx.save();
          for (const zone of partialFailureZones) {
            const cx = scales.x.getPixelForValue(new Date(zone.xMin).getTime());
            const renderLeft  = Math.max(cx - 2, chartArea.left);
            const renderRight = Math.min(cx + 2, chartArea.right);
            if (renderRight <= renderLeft) continue;
            const active = hoveredPartialZone && zone.xMin === hoveredPartialZone.xMin;
            ctx.fillStyle = active ? 'rgba(234, 179, 8, 0.45)' : 'rgba(234, 179, 8, 0.25)';
            ctx.fillRect(renderLeft, chartArea.top, renderRight - renderLeft, chartArea.height);
            ctx.strokeStyle = active ? 'rgba(234, 179, 8, 0.9)' : 'rgba(234, 179, 8, 0.7)';
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(cx, chartArea.top); ctx.lineTo(cx, chartArea.bottom); ctx.stroke();
          }
          ctx.restore();
        }
        // Pass 2: red outage bands (drawn on top)
        if (outageZones.length) {
          ctx.save();
          for (const zone of outageZones) {
            const x1 = Math.max(scales.x.getPixelForValue(new Date(zone.xMin).getTime()), chartArea.left);
            const x2 = Math.min(scales.x.getPixelForValue(new Date(zone.xMax).getTime()), chartArea.right);
            if (x2 <= x1) continue;
            const active = hoveredZone && zone.xMin === hoveredZone.xMin;
            ctx.fillStyle = active ? 'rgba(239, 68, 68, 0.4)' : 'rgba(239, 68, 68, 0.15)';
            ctx.fillRect(x1, chartArea.top, x2 - x1, chartArea.height);
            ctx.strokeStyle = active ? 'rgba(239, 68, 68, 0.9)' : 'rgba(239, 68, 68, 0.5)';
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(x1, chartArea.top); ctx.lineTo(x1, chartArea.bottom); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(x2, chartArea.top); ctx.lineTo(x2, chartArea.bottom); ctx.stroke();
          }
          ctx.restore();
        }
      },
      afterEvent(chart, args) {
        const e = args.event;
        const { chartArea, scales } = chart;
        const tooltip = document.getElementById('outage-tooltip');
        const outageRows   = document.querySelectorAll('.outage-list tbody tr[data-xmin]');
        const degradedRows = document.querySelectorAll('.degraded-list tbody tr[data-xmin]');
        outageRows.forEach(function(r){ r.classList.remove('hovered'); });
        degradedRows.forEach(function(r){ r.classList.remove('hovered'); });
        if (e.type === 'mousemove' && e.x >= chartArea.left && e.x <= chartArea.right
            && e.y >= chartArea.top && e.y <= chartArea.bottom) {
          const t = scales.x.getValueForPixel(e.x);
          // Check outage zones first (take visual priority)
          let foundOutage = null;
          for (let i = 0; i < outageZones.length; i++) {
            const zone = outageZones[i];
            if (t >= new Date(zone.xMin).getTime() && t <= new Date(zone.xMax).getTime()) {
              foundOutage = zone;
              break;
            }
          }
          if (foundOutage) {
            if (!hoveredZone || hoveredZone.xMin !== foundOutage.xMin) {
              hoveredZone = foundOutage;
              args.changed = true;
            }
            if (hoveredPartialZone) { hoveredPartialZone = null; args.changed = true; }
            const durMs = new Date(foundOutage.xMax).getTime() - new Date(foundOutage.xMin).getTime();
            const durStr = foundOutage.ongoing
              ? 'ongoing (~' + fmtDur(durMs) + ' so far)'
              : fmtDur(durMs);
            tooltip.innerHTML =
              '<b>Outage</b><br>' +
              'Start: ' + new Date(foundOutage.xMin).toLocaleString() + '<br>' +
              'Duration: ' + durStr;
            tooltip.style.borderColor = 'rgba(239,68,68,0.5)';
            tooltip.style.display = 'block';
            const tooFarRight = e.native.clientX + 14 + tooltip.offsetWidth > window.innerWidth;
            tooltip.style.left = (tooFarRight ? e.native.clientX - 14 - tooltip.offsetWidth : e.native.clientX + 14) + 'px';
            tooltip.style.top  = (e.native.clientY - 10) + 'px';
            outageRows.forEach(function(r){ if (r.dataset.xmin === foundOutage.xMin) r.classList.add('hovered'); });
            chart.canvas.style.cursor = 'pointer';
            return;
          }
          // Check partial failure zones by pixel proximity
          let foundPartial = null;
          for (let i = 0; i < partialFailureZones.length; i++) {
            const zone = partialFailureZones[i];
            const px = scales.x.getPixelForValue(new Date(zone.xMin).getTime());
            if (Math.abs(e.x - px) <= 4) { foundPartial = zone; break; }
          }
          if (foundPartial) {
            if (!hoveredPartialZone || hoveredPartialZone.xMin !== foundPartial.xMin) {
              hoveredPartialZone = foundPartial;
              args.changed = true;
            }
            if (hoveredZone) { hoveredZone = null; args.changed = true; }
            const epLines = foundPartial.failedEndpoints.length > 0
              ? '<br>' + foundPartial.failedEndpoints.map(function(ep){ return '&nbsp;&nbsp;' + ep.host + ':' + ep.port; }).join('<br>')
              : '';
            tooltip.innerHTML =
              '<b>Degraded</b><br>' +
              'Time: ' + new Date(foundPartial.xMin).toLocaleString() + '<br>' +
              'Failed: ' + foundPartial.failedCount + '/' + foundPartial.totalEndpoints + ' endpoints' + epLines;
            tooltip.style.borderColor = 'rgba(234,179,8,0.5)';
            tooltip.style.display = 'block';
            const tooFarRight = e.native.clientX + 14 + tooltip.offsetWidth > window.innerWidth;
            tooltip.style.left = (tooFarRight ? e.native.clientX - 14 - tooltip.offsetWidth : e.native.clientX + 14) + 'px';
            tooltip.style.top  = (e.native.clientY - 10) + 'px';
            degradedRows.forEach(function(r){ if (r.dataset.xmin === foundPartial.xMin) r.classList.add('hovered'); });
            chart.canvas.style.cursor = 'pointer';
            return;
          }
        }
        if (hoveredZone) { hoveredZone = null; args.changed = true; }
        if (hoveredPartialZone) { hoveredPartialZone = null; args.changed = true; }
        tooltip.style.display = 'none';
        chart.canvas.style.cursor = 'default';
      },
    };
    Chart.register(outageBandsPlugin);
    const ctx = document.getElementById('chart').getContext('2d');
    const myChart = new Chart(ctx, {
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
            type: 'logarithmic',
            min: 1,
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
    myChart.canvas.addEventListener('mouseleave', function(){
      document.getElementById('outage-tooltip').style.display = 'none';
      document.querySelectorAll('.outage-list tbody tr').forEach(function(r){ r.classList.remove('hovered'); });
      document.querySelectorAll('.degraded-list tbody tr').forEach(function(r){ r.classList.remove('hovered'); });
      myChart.canvas.style.cursor = 'default';
      if (hoveredZone || hoveredPartialZone) { hoveredZone = null; hoveredPartialZone = null; myChart.update('none'); }
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

  const { successPoints, failurePoints, outageZones, partialFailureZones, quarantineZones } = buildDatasets(entries);
  const html = buildHtml({
    successPoints,
    failurePoints,
    outageZones,
    partialFailureZones,
    quarantineZones,
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

export async function main(): Promise<void> {
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
      generate(logPath, since, outPath, true).catch((err: unknown) => {
        console.error('Regeneration failed:', err);
      });
    }, 60_000);
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
