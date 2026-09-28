// ==============================================================================
// Lightweight Structured Logger
// ==============================================================================

export type LogLevel = "debug" | "info" | "warn" | "error";

export class Logger {
  constructor(private serviceName: string) {}

  private formatMessage(level: LogLevel, message: string, meta?: unknown) {
    const timestamp = new Date().toISOString();
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : "";
    return `[${timestamp}] [${level.toUpperCase()}] [${this.serviceName}]: ${message}${metaStr}`;
  }

  debug(message: string, meta?: unknown) {
    if (process.env.LOG_LEVEL === "debug") {
      console.debug(this.formatMessage("debug", message, meta));
    }
  }

  info(message: string, meta?: unknown) {
    console.info(this.formatMessage("info", message, meta));
  }

  warn(message: string, meta?: unknown) {
    console.warn(this.formatMessage("warn", message, meta));
  }

  error(message: string, meta?: unknown) {
    console.error(this.formatMessage("error", message, meta));
  }
}

export const createLogger = (serviceName: string) => new Logger(serviceName);

