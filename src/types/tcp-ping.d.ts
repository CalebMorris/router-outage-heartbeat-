declare module 'tcp-ping' {
  interface PingOptions {
    address: string;
    port: number;
    timeout?: number;
    attempts?: number;
  }

  interface PingData {
    address: string;
    port: number;
    attempts: number;
    avg: number | undefined;
    max: number | undefined;
    min: number | undefined;
    results: Array<{ seq: number; time: number | undefined }>;
  }

  function ping(options: PingOptions, callback: (err: Error | null, data: PingData) => void): void;
}
