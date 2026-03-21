import * as os from 'os';
import * as path from 'path';

export interface Endpoint {
  host: string;
  port: number;
}

export interface Config {
  normalIntervalMs: number;
  outageIntervalMs: number;
  consecutiveFailuresForOutage: number;
  consecutiveSuccessesForRecovery: number;
  pingTimeoutMs: number;
  endpoints: Endpoint[];
  logPath: string;
}

export const CONFIG: Config = {
  normalIntervalMs: 30_000,
  outageIntervalMs: 2_000,
  consecutiveFailuresForOutage: 2,
  consecutiveSuccessesForRecovery: 3,
  pingTimeoutMs: 5_000,
  endpoints: [
    { host: '8.8.8.8', port: 53 },
    { host: '1.1.1.1', port: 53 },
    { host: 'google.com', port: 443 },
    { host: 'cloudflare.com', port: 443 },
  ],
  logPath: path.join(os.homedir(), '.local', 'share', 'router-outage-heartbeat', 'heartbeat.log'),
};
