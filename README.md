# Router Outage Heartbeat

A background daemon that detects and logs internet outages for ISP reporting. It pings external endpoints on a regular schedule, switches to rapid polling when an outage is detected, and logs structured JSON events so you can generate a report to share with your ISP.

---

## How it works

- Probes external endpoints in round-robin on a regular interval
- On the first probe failure, enters **bulkhead mode**: immediately pings every active endpoint in parallel
- If a majority of those endpoints fail, declares an outage and switches to rapid polling
- If a minority fail, the failing endpoints are **quarantined** — removed from rotation and rechecked on exponential backoff (1m → 2m → … → 60m). Once a recheck succeeds, the endpoint is restored
- If a majority succeed (false alarm), normal polling resumes immediately
- When enough consecutive probes succeed after an outage, declares recovery and returns to normal intervals
- All probe results, outage events, and endpoint health events are written as JSON to a log file

---

## Requirements

- Node.js (via nvm or system install)
- Linux with systemd user services enabled

---

## Installation

**1. Install dependencies and build:**
```bash
npm install
npm run build
```

**2. Install and start the service:**
```bash
npm run service:install
```

This builds the project, installs the systemd user service, enables it, and starts it. The service will automatically restart on crash and start at boot.

**3. Install log rotation:**
```bash
sudo cp logrotate.d/router-outage-heartbeat /etc/logrotate.d/
```

This configures the system to rotate the log file daily, keeping 30 days of history.

> **Note:** If your Node.js is installed via nvm, the service file at
> `systemd/router-outage-heartbeat.service` has a hardcoded nvm path. If you
> upgrade Node, update the version in `ExecStart` and re-run `npm run service:install`.

---

## Service management

```bash
npm run service:status     # Show current status
npm run service:start      # Start the service
npm run service:stop       # Stop the service
npm run service:restart    # Restart the service
npm run service:install    # Build + reinstall + restart
```

On every start, the journal will show which endpoints are being monitored:
```bash
npm run log:journal
# node[1234]: router-outage-heartbeat starting — monitoring: 8.8.8.8:53, 1.1.1.1:53, ...
```

---

## Monitoring

**Watch the structured JSON log in real time:**
```bash
npm run log:tail           # all events
npm run log:tail:failures  # only failed probes (success: false)
```

**Watch the systemd journal (service lifecycle + errors):**
```bash
npm run log:journal
```

**View everything since last boot:**
```bash
npm run log:journal:boot
```

Log file location: `~/.local/share/router-outage-heartbeat/heartbeat.log`

Each line is a JSON event. Event types:

| `event` | When |
|---|---|
| `startup` | Service started |
| `shutdown` | Service stopped gracefully |
| `probe` | Every ping attempt (includes `state: normal\|bulkhead\|outage`) |
| `bulkhead_check` | Active endpoints blasted in parallel after first failure (includes `totalEndpoints`, `failedCount`, `majorityFailed`) |
| `outage_start` | Bulkhead check confirmed majority of active endpoints unreachable |
| `outage_end` | Consecutive successes threshold reached after an outage (includes `durationMs`) |
| `endpoint_quarantined` | An endpoint failed bulkhead check (minority) and was removed from rotation (includes `backoffMs`) |
| `endpoint_restored` | A quarantined endpoint passed its recheck and returned to rotation (includes `durationMs`) |

---

## Analyzing outages

```bash
npm run analyze                              # Outage summary report (default)
npm run analyze -- --mode request            # All probe events
npm run analyze -- --mode outage             # Only probes during outage windows
npm run analyze -- --format csv              # CSV output for spreadsheet import
npm run --silent analyze -- --format csv > report.csv # Save CSV to file (--silent suppresses npm banner)
npm run analyze -- --since 2026-03-01        # Filter by date
```

**Summary report** shows: total outage count, total downtime, mean/min/max duration, most common hour, and a per-outage table.

**CSV report** columns: `started_at`, `ended_at`, `duration_ms`, `duration_human` — suitable for sharing with an ISP.

---

## Graphing outages

Generate an interactive HTML chart showing latency over time with outage zones highlighted:

```bash
npm run graph                                    # Write heartbeat-graph.html to current directory
npm run graph -- --since 2026-03-01              # Filter to data after a date
npm run graph -- --out ~/Desktop/report.html     # Custom output path
npm run graph -- --open                          # Auto-open in browser after generating
```

The chart shows:
- **Blue dots** — successful probes with their TCP latency in ms
- **Red × marks** — failed probes (plotted at 0 ms)
- **Red shaded bands** — outage windows (outage_start → outage_end)
- **Yellow lines** — degraded checks (partial failure, minority of endpoints failed)
- **Unhealthy Endpoints table** — endpoints currently quarantined, with how long they've been down

Open the generated HTML file in any browser. No internet connection required to view it — Chart.js loads from CDN and the data is embedded inline.

---

## Configuration

All tunable values are in `src/config.ts`. After any change, rebuild and reinstall:

```bash
npm run build && npm run service:restart
```

| Setting | Default | Description |
|---|---|---|
| `normalIntervalMs` | 5s | Probe interval during normal operation |
| `outageIntervalMs` | 100ms | Probe interval during an outage |
| `consecutiveSuccessesForRecovery` | 5 | Successes required to declare recovery |
| `pingTimeoutMs` | 1s | Per-probe TCP timeout |
| `endpoints` | list | Endpoints to probe in round-robin |
| `endpointQuarantineInitialBackoffMs` | 1m | First recheck delay for a quarantined endpoint |
| `endpointQuarantineMaxBackoffMs` | 1h | Maximum recheck delay |
| `endpointQuarantineBackoffMultiplier` | 2 | Backoff multiplier per failed recheck |
| `minActiveEndpoints` | 20 | Minimum active pool size — quarantine is skipped if this floor would be breached |

**To test outage detection without unplugging:** temporarily replace most entries in `endpoints` with `{ host: 'localhost', port: 9999 }`, rebuild, and restart. The first probe failure will trigger a bulkhead check; since the majority of endpoints are unreachable, it will immediately declare an outage. Restore the original list and restart when done.

---

## Development

```bash
npm run dev     # Run with ts-node, logs to stdout
npm run build   # Compile TypeScript to dist/
npm run lint    # Run ESLint
npm test        # Run Jest test suite
```
