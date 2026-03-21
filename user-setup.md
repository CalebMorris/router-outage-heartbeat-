# Setup & Verification Guide

## 1. Install the service

```bash
bash scripts/install-service.sh
```

This builds, copies the unit file, enables, and starts the service.

---

## 2. Confirm it's running

```bash
systemctl --user status router-outage-heartbeat
```

Look for `active (running)`. If it failed, check:

```bash
journalctl --user -u router-outage-heartbeat -n 50
```

---

## 3. Verify it's logging

Wait 60–90 seconds, then:

```bash
tail -f ~/.local/share/router-outage-heartbeat/heartbeat.log | jq .
```

You should see `probe` events every 30 seconds. If the file doesn't exist, the service likely didn't start — check the journal.

---

## 4. Test outage detection

Without unplugging anything, temporarily add a failing endpoint by editing `src/config.ts` — change one endpoint to `localhost:9999`. Rebuild and restart:

```bash
npm run build && systemctl --user restart router-outage-heartbeat
journalctl --user -u router-outage-heartbeat -f
```

After 2 ticks (~4 seconds) you should see `outage_start` in the log. Revert the config, rebuild, restart to restore normal operation.

---

## 5. Test crash recovery

```bash
kill -9 $(systemctl --user show -p MainPID --value router-outage-heartbeat)
sleep 6
systemctl --user status router-outage-heartbeat
```

Should show the service restarted automatically.

---

## 6. Install logrotate config

```bash
sudo cp logrotate.d/router-outage-heartbeat /etc/logrotate.d/
sudo logrotate --debug /etc/logrotate.d/router-outage-heartbeat
```

The `--debug` flag does a dry run so you can confirm it finds the log file without actually rotating it.

---

## 7. Verify boot persistence

```bash
loginctl show-user "$USER" | grep Linger
```

Should show `Linger=yes`. If not, run:

```bash
loginctl enable-linger "$USER"
```

---

## Analyzing collected data

Once data has accumulated (a day or two), run the analysis:

```bash
npm run analyze                          # outage summary
npm run analyze -- --mode request        # all probes
npm run analyze -- --mode outage         # only probes during outage windows
npm run analyze -- --format csv > report.csv
npm run analyze -- --since 2026-03-01   # filter by date
```
