import * as os from 'os';
import * as path from 'path';

export interface Endpoint {
  host: string;
  port: number;
}

export interface Config {
  normalIntervalMs: number;
  outageIntervalMs: number;
  consecutiveSuccessesForRecovery: number;
  pingTimeoutMs: number;
  endpoints: Endpoint[];
  logPath: string;
}

export const CONFIG: Config = {
  normalIntervalMs: 20_000,
  outageIntervalMs: 500,
  consecutiveSuccessesForRecovery: 5,
  pingTimeoutMs: 1_000,
  endpoints: [
    // Google DNS
    { host: '8.8.8.8',         port: 53  },
    { host: '8.8.4.4',         port: 53  },
    // Cloudflare DNS
    { host: '1.1.1.1',         port: 53  },
    { host: '1.0.0.1',         port: 53  },
    // Quad9
    { host: '9.9.9.9',         port: 53  },
    { host: '149.112.112.112', port: 53  },
    // OpenDNS / Cisco
    { host: '208.67.222.222',  port: 53  },
    { host: '208.67.220.220',  port: 53  },
    // Verisign Public DNS
    { host: '64.6.64.6',       port: 53  },
    { host: '64.6.65.6',       port: 53  },
    // Level3 / Lumen (4.2.2.x — decades-stable)
    { host: '4.2.2.1',         port: 53  },
    { host: '4.2.2.2',         port: 53  },
    { host: '4.2.2.3',         port: 53  },
    // AdGuard DNS
    { host: '94.140.14.14',    port: 53  },
    { host: '94.140.15.15',    port: 53  },
    // CleanBrowsing
    { host: '185.228.168.9',   port: 53  },
    { host: '185.228.169.9',   port: 53  },
    // DNS.Watch
    { host: '84.200.69.80',    port: 53  },
    { host: '84.200.70.40',    port: 53  },
    // Comodo Secure DNS
    { host: '8.26.56.26',      port: 53  },
    { host: '8.20.247.20',     port: 53  },
    // Neustar UltraDNS
    { host: '156.154.70.1',    port: 53  },
    { host: '156.154.71.1',    port: 53  },
    // NextDNS
    { host: '45.90.28.1',      port: 53  },
    { host: '45.90.30.1',      port: 53  },
    // Hostname-based HTTPS (also exercises DNS resolution)
    { host: 'google.com',      port: 443 },
    { host: 'cloudflare.com',  port: 443 },
    { host: 'one.one.one.one', port: 443 },
    { host: 'dns.google',      port: 443 },
    { host: 'quad9.net',       port: 443 },
  ],
  logPath: path.join(os.homedir(), '.local', 'share', 'router-outage-heartbeat', 'heartbeat.log'),
};
