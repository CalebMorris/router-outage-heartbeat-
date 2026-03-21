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

export interface ShutdownEvent {
  event: 'shutdown';
  reason: string;
}

export type LogEvent = ProbeEvent | OutageStartEvent | OutageEndEvent | StartupEvent | ShutdownEvent;

let logger: pino.Logger;

export function initLogger(logPath: string): void {
  const isProduction = process.env['NODE_ENV'] === 'production';

  if (isProduction) {
    const dir = path.dirname(logPath);
    fs.mkdirSync(dir, { recursive: true });
    const stream = pino.destination({ dest: logPath, sync: false });
    logger = pino({ timestamp: pino.stdTimeFunctions.isoTime }, stream);
  } else {
    logger = pino({
      timestamp: pino.stdTimeFunctions.isoTime,
    });
  }
}

export function logEvent(eventData: LogEvent): void {
  if (!logger) {
    throw new Error('Logger not initialized. Call initLogger() first.');
  }
  logger.info(eventData);
}
