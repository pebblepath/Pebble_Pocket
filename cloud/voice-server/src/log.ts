/**
 * Structured logger: one JSON object per line on stdout.
 *
 * Field names are `severity`, `message` and `time`, plus any extra fields.
 * Tokens and audio payloads must never be passed in.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SEVERITY: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
};

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export type LogSink = (line: string) => void;

export function createLogger(
  level: LogLevel = 'info',
  base: LogFields = {},
  sink: LogSink = (line) => process.stdout.write(line + '\n'),
): Logger {
  const min = ORDER[level];
  const emit = (lvl: LogLevel, message: string, fields?: LogFields): void => {
    if (ORDER[lvl] < min) return;
    const record: LogFields = {
      severity: SEVERITY[lvl],
      message,
      time: new Date().toISOString(),
      ...base,
      ...fields,
    };
    let line: string;
    try {
      line = JSON.stringify(record, (_key, value: unknown) =>
        value instanceof Error ? { name: value.name, message: value.message } : value,
      );
    } catch {
      line = JSON.stringify({ severity: SEVERITY[lvl], message, time: record['time'] });
    }
    sink(line);
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => createLogger(level, { ...base, ...fields }, sink),
  };
}

/** Longest device- or client-supplied string written to a log line. */
export const MAX_LOGGED_STRING_CHARS = 120;

/**
 * Truncates an untrusted string before it is logged, so a peer cannot turn one
 * message into a very large log line. Non-strings pass through unchanged.
 */
export function clip(value: unknown, max = MAX_LOGGED_STRING_CHARS): unknown {
  if (typeof value !== 'string' || value.length <= max) return value;
  return `${value.slice(0, max)}...(${value.length} chars)`;
}

/**
 * Logs an untrusted JSON-like object as-is when small, otherwise as a truncated
 * preview plus its serialized size.
 */
export function clipObject(value: unknown, maxChars = 256): unknown {
  let json: string;
  try {
    json = JSON.stringify(value) ?? '';
  } catch {
    return '(unserializable)';
  }
  if (json.length <= maxChars) return value;
  return { preview: json.slice(0, maxChars), chars: json.length };
}

/** A logger that discards everything (used by tests). */
export const silentLogger: Logger = createLogger('error', {}, () => {});
