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
- Monitor loop lives in `src/monitor.ts` (`Monitor` class with injected `probe`/`log` deps); `src/index.ts` is a thin bootstrap
- Config in `src/config.ts` is the single source of truth for all tunable values
- Log events are typed in `src/logger.ts`; adding a new event type requires updating the discriminated union
- Outage requires a majority of active endpoints to fail the bulkhead check (not 1) to avoid false positives
- Endpoint health is tracked in `src/endpoint-health.ts` (`EndpointHealth` class); flaky individual endpoints are quarantined separately from router-wide outage detection

## Endpoint Quarantine
- When a bulkhead check reveals a minority of endpoints failing, those endpoints are quarantined (removed from rotation)
- Quarantined endpoints are rechecked on exponential backoff (1m → 2m → … → 60m max) via their own independent `setTimeout` chains — NOT in the main tick — to avoid blowing the 100ms outage polling budget
- 1 successful recheck restores an endpoint to rotation
- Quarantined endpoints are excluded from the majority-failed calculation in future bulkhead checks
- `minActiveEndpoints` (default: 20) is a floor: quarantine is skipped if it would drop the active pool below this threshold
- Graph shows currently unhealthy endpoints in an "Unhealthy Endpoints" section below the chart

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

## Testing
npm test            # run Jest test suite (31 tests)

- Unit tests: `tests/unit/` — covers `StateMachine`, `EndpointHealth`, `EndpointRotator`
- Integration tests: `tests/integration/` — covers full Monitor timing/behavior with fake timers
- Uses Jest 29 with `jest.runAllTimersAsync()` to correctly handle `setTimeout` + `Promise.all` interleaving
- `tsconfig.test.json` extends the main tsconfig to include `tests/**/*`

## Scripts Architecture
- All scripts in `scripts/` run via `ts-node` directly — they are NOT compiled by `tsc` (`tsconfig.json` only includes `src/**/*`)
- Scripts redeclare their own local types rather than importing from `src/` to avoid pulling in pino and daemon code
- ESLint enforces `@typescript-eslint/explicit-function-return-type: error` — every function (including callbacks) needs an explicit return type
- `tsconfig.json` has `lib: ["ES2022"]` with no `"DOM"` — browser-side code lives only inside embedded HTML template strings and is never type-checked
- Chart.js v4 + chartjs-adapter-date-fns v3 are loaded via CDN inside the HTML template; no local install
- Scatter plot data points carry `host` and `port` fields alongside `x`/`y` so tooltips can show the endpoint
