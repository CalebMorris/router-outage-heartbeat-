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
