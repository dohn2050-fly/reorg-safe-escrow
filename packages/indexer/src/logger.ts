// Minimal structured logger (no runtime dependency). Levels: debug < info < warn < error.

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFormat = "pretty" | "json";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const COLORS: Record<LogLevel, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
const RESET = "\x1b[0m";

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  format?: LogFormat;
  sink?: (line: string) => void;
}

function serialise(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.map(serialise);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, serialise(v)]));
  }
  return value;
}

export function createLogger(opts: LoggerOptions = {}, bindings: Record<string, unknown> = {}): Logger {
  const level = opts.level ?? "info";
  const format = opts.format ?? "pretty";
  const sink = opts.sink ?? ((line: string) => process.stdout.write(line + "\n"));
  const threshold = LEVELS[level];

  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (LEVELS[lvl] < threshold) return;
    const merged = serialise({ ...bindings, ...(fields ?? {}) }) as Record<string, unknown>;
    if (format === "json") {
      sink(JSON.stringify({ level: lvl, time: new Date().toISOString(), msg, ...merged }));
      return;
    }
    const time = new Date().toISOString().slice(11, 23);
    const extra = Object.keys(merged).length ? " " + JSON.stringify(merged) : "";
    sink(`${COLORS[lvl]}${time} ${lvl.toUpperCase().padEnd(5)}${RESET} ${msg}${extra}`);
  };

  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (b) => createLogger(opts, { ...bindings, ...b }),
  };
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};
