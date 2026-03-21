import tcpPing from 'tcp-ping';

export interface PingResult {
  success: boolean;
  latencyMs: number | null;
  host: string;
  port: number;
  timestamp: string;
}

export function probeEndpoint(host: string, port: number, timeoutMs: number): Promise<PingResult> {
  const timestamp = new Date().toISOString();
  return new Promise((resolve) => {
    tcpPing.ping(
      { address: host, port, timeout: timeoutMs, attempts: 1 },
      (err: Error | null, data) => {
        if (err || data === undefined || data.avg === undefined || isNaN(data.avg)) {
          resolve({ success: false, latencyMs: null, host, port, timestamp });
        } else {
          resolve({ success: true, latencyMs: data.avg, host, port, timestamp });
        }
      },
    );
  });
}
