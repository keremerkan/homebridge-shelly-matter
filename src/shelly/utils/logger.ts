/**
 * Minimal local replacement for the node-ansi-logger package (Apache-2.0, by
 * Luligu - see NOTICE), implementing only the surface this plugin uses.
 * Replacing the dependency removes a package whose published tarball carries
 * an npm-shrinkwrap file that dependency scanners flag (harmlessly - it locks
 * nothing - but an alert is an alert). Output format matches the original:
 * "[HH:MM:SS.mmm] [name] message" with the same ANSI palette.
 */

const ESC = '\u001b';

// Base ANSI codes
export const RESET = `${ESC}[0m`;
export const BRIGHT = `${ESC}[1m`;
export const GREEN = `${ESC}[32m`;
export const YELLOW = `${ESC}[33m`;
export const BLUE = `${ESC}[34m`;
export const MAGENTA = `${ESC}[35m`;
export const CYAN = `${ESC}[36m`;
export const GREY = `${ESC}[90m`;

// Semantic shortcuts. node-ansi-logger used a 256-color palette here, which
// stood out against Homebridge's plain-colored output; these map to standard
// colors instead so the plugin's lines blend with the rest of the log.
// Debug/info/warn/error match Homebridge's look; the id/name/host accents
// all collapse to standard cyan.
export const db = GREY; // debug
export const dn = `${ESC}[36m`; // device name accent
export const er = `${ESC}[31m`; // error
export const hk = `${ESC}[36m`; // id accent
export const idn = `${ESC}[7m`; // inverted device name
export const ign = `${ESC}[7m`; // inverted accent
export const nf = ''; // info: terminal default, like Homebridge
export const nt = `${ESC}[32m`; // notice
export const rk = `${ESC}[K`; // erase to end of line
export const rs = `${ESC}[0m`; // reset
export const wr = `${ESC}[33m`; // warn
export const zb = `${ESC}[36m`; // host accent

const NAME_COLOR = `${ESC}[36m`;

export enum LogLevel {
  NONE = '',
  DEBUG = 'debug',
  INFO = 'info',
  NOTICE = 'notice',
  WARN = 'warn',
  ERROR = 'error',
  FATAL = 'fatal',
}

export enum TimestampFormat {
  TIME_MILLIS = 4,
}

const LEVEL_ORDER: Record<string, number> = { debug: 0, info: 1, notice: 2, warn: 3, error: 4, fatal: 5, '': 6 };
const LEVEL_COLOR: Record<string, string> = { debug: db, info: nf, notice: nt, warn: wr, error: er, fatal: er };

const timestamp = (): string => {
  const now = new Date();
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
};

export interface AnsiLoggerParams {
  logName?: string;
  logTimestampFormat?: TimestampFormat;
  logLevel?: LogLevel;
}

export class AnsiLogger {
  logName: string;
  logLevel: LogLevel;

  constructor(params: AnsiLoggerParams = {}) {
    this.logName = params.logName ?? 'Logger';
    this.logLevel = params.logLevel ?? LogLevel.INFO;
  }

  log(level: LogLevel, message: string, ...parameters: unknown[]): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.logLevel]) return;
    const color = LEVEL_COLOR[level] ?? nf;
    // eslint-disable-next-line no-console
    console.log(`${db}[${timestamp()}] ${NAME_COLOR}[${this.logName}]${RESET}${color} ${message}${RESET}${rk}`, ...parameters);
  }

  debug(message: string, ...parameters: unknown[]): void {
    this.log(LogLevel.DEBUG, message, ...parameters);
  }

  info(message: string, ...parameters: unknown[]): void {
    this.log(LogLevel.INFO, message, ...parameters);
  }

  notice(message: string, ...parameters: unknown[]): void {
    this.log(LogLevel.NOTICE, message, ...parameters);
  }

  warn(message: string, ...parameters: unknown[]): void {
    this.log(LogLevel.WARN, message, ...parameters);
  }

  error(message: string, ...parameters: unknown[]): void {
    this.log(LogLevel.ERROR, message, ...parameters);
  }

  fatal(message: string, ...parameters: unknown[]): void {
    this.log(LogLevel.FATAL, message, ...parameters);
  }
}

/** Compact payload stringifier for debug messages. */
export const debugStringify = (payload: unknown): string => {
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
};
