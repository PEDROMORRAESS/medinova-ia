type LogLevel = 'info' | 'warn' | 'error' | 'debug';

function log(level: LogLevel, message: string, data?: unknown): void {
  const timestamp = new Date().toISOString();
  const entry: Record<string, unknown> = { timestamp, level, message };
  if (data !== undefined) {
    entry['data'] = data instanceof Error ? { message: data.message, stack: data.stack } : data;
  }
  const output = JSON.stringify(entry);
  if (level === 'error') {
    console.error(output);
  } else {
    console.log(output);
  }
}

export const logger = {
  info: (message: string, data?: unknown) => log('info', message, data),
  warn: (message: string, data?: unknown) => log('warn', message, data),
  error: (message: string, data?: unknown) => log('error', message, data),
  debug: (message: string, data?: unknown) => log('debug', message, data),
};
