import * as fs from 'fs';
import * as path from 'path';
import pino from 'pino';
import { MonitorState } from './state-machine';
import { Config } from './config';

export interface ProbeEvent {
  event: 'probe';
  host: string;
  port: number;
  success: boolean;
  latencyMs: number | null;
  state: MonitorState;
}

export interface OutageStartEvent {
  event: 'outage_start';
  host: string;
  port: number;
  outageStartedAt: string;
}

export interface OutageEndEvent {
  event: 'outage_end';
  durationMs: number;
  outageStartedAt: string;
  outageEndedAt: string;
}

export interface StartupEvent {
  event: 'startup';
  config: Config;
}

export interface BulkheadCheckEvent {
  event: 'bulkhead_check';
  totalEndpoints: number;
  failedCount: number;
  majorityFailed: boolean;
  failedEndpoints: Array<{ host: string; port: number }>;
}

export interface ShutdownEvent {
  event: 'shutdown';
  reason: string;
}

export interface StartupHealthCheckEvent {
  event: 'startup_health_check';
  totalEndpoints: number;
  failedCount: number;
  failedEndpoints: Array<{ host: string; port: number }>;
  allHealthy: boolean;
}

export interface EndpointQuarantinedEvent {
  event: 'endpoint_quarantined';
  host: string;
  port: number;
  backoffMs: number;
}

export interface EndpointRestoredEvent {
  event: 'endpoint_restored';
  host: string;
  port: number;
  quarantinedAt: string;
  restoredAt: string;
  durationMs: number;
}

export type LogEvent = ProbeEvent | BulkheadCheckEvent | OutageStartEvent | OutageEndEvent | StartupEvent | ShutdownEvent | StartupHealthCheckEvent | EndpointQuarantinedEvent | EndpointRestoredEvent;

let logger: pino.Logger;
let productionStream: ReturnType<typeof pino.destination> | null = null;

export function initLogger(logPath: string): void {
  const isProduction = process.env['NODE_ENV'] === 'production';

  if (isProduction) {
    const dir = path.dirname(logPath);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
    } catch (err) {
      process.stderr.write(`Failed to create log directory ${dir}: ${String(err)}\n`);
      process.exit(1);
    }
    try {
      productionStream = pino.destination({ dest: logPath, sync: true });
      logger = pino({ timestamp: pino.stdTimeFunctions.isoTime }, productionStream);
    } catch (err) {
      process.stderr.write(`Failed to open log file ${logPath}: ${String(err)}\n`);
      process.exit(1);
    }
  } else {
    logger = pino({
      timestamp: pino.stdTimeFunctions.isoTime,
    });
  }
}

// Called on SIGHUP so logrotate can mv the file and we reopen a fresh handle.
export function reopenLog(): void {
  if (productionStream) {
    productionStream.reopen();
  }
}

export function logEvent(eventData: LogEvent): void {
  if (!logger) {
    throw new Error('Logger not initialized. Call initLogger() first.');
  }
  logger.info(eventData);
}
