# Router Outage Heartbeat — CLAUDE.md

## Project Purpose
A Node.js/TypeScript background process that detects and logs internet outages for ISP reporting.
Runs as a systemd user service. Pings external endpoints, switches to rapid polling during outages.

## Stack
- **Ping**: `tcp-ping` (TCP-based, no root required)
- **Logging**: `pino` → `~/.local/share/router-outage-heartbeat/heartbeat.log` (JSON, one event per line)
- **Process**: systemd user service (`~/.config/systemd/user/`)
- **Scheduling**: recursive `setTimeout` (NOT setInterval — respects dynamic interval changes)

## Key Design Patterns
- State machine in `src/state-machine.ts` is the central logic — everything feeds into it
- Config in `src/config.ts` is the single source of truth for all tunable values
- Log events are typed in `src/logger.ts`; adding a new event type requires updating the discriminated union
- Outage requires 2 consecutive failures (not 1) to avoid false positives from a single flaky endpoint

## Running Locally
npm run dev         # ts-node, logs to stdout
npm run build       # compile to dist/
npm start           # run compiled dist/index.js

## Service Management
systemctl --user status router-outage-heartbeat
systemctl --user restart router-outage-heartbeat
journalctl --user -u router-outage-heartbeat -f

## Log Analysis
npm run analyze                        # text report
npm run analyze -- --format csv        # CSV for ISP
npm run analyze -- --since 2026-03-01  # filtered range

## Graph / Visualization
npm run graph                          # static HTML file (heartbeat-graph.html in cwd)
npm run graph -- --since 2026-03-01    # filtered range
npm run graph -- --out /tmp/out.html   # custom output path
npm run live                           # live mode: opens /tmp/heartbeat-live.html, regenerates every 60s

## Scripts Architecture
- All scripts in `scripts/` run via `ts-node` directly — they are NOT compiled by `tsc` (`tsconfig.json` only includes `src/**/*`)
- Scripts redeclare their own local types rather than importing from `src/` to avoid pulling in pino and daemon code
- ESLint enforces `@typescript-eslint/explicit-function-return-type: error` — every function (including callbacks) needs an explicit return type
- `tsconfig.json` has `lib: ["ES2022"]` with no `"DOM"` — browser-side code lives only inside embedded HTML template strings and is never type-checked
- Chart.js v4 + chartjs-adapter-date-fns v3 are loaded via CDN inside the HTML template; no local install
- Scatter plot data points carry `host` and `port` fields alongside `x`/`y` so tooltips can show the endpoint
