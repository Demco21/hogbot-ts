import { LogLevel, ILogger } from '@sapphire/framework';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Get log level based on environment
 */
export function getLogLevel(): LogLevel {
  const env = process.env.NODE_ENV || 'development';
  return env === 'production' ? LogLevel.Info : LogLevel.Debug;
}

/**
 * Custom Winston logger format
 */
const customFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, stack }) => {
    const formattedLevel = level.toUpperCase().padEnd(7);
    if (stack) {
      return `[${timestamp}] [${formattedLevel}] ${message}\n${stack}`;
    }
    return `[${timestamp}] [${formattedLevel}] ${message}`;
  })
);

/**
 * Console format with colors for development
 */
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, stack }) => {
    if (stack) {
      return `[${timestamp}] ${level}: ${message}\n${stack}`;
    }
    return `[${timestamp}] ${level}: ${message}`;
  })
);

/**
 * Create Winston logger instance with file rotation
 */
export const winstonLogger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  transports: [
    // Console transport
    new winston.transports.Console({
      format: consoleFormat,
    }),
    // Daily rotating file transport
    new DailyRotateFile({
      filename: path.join(__dirname, '../../data/hogbot-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m', // Rotate when file reaches 20MB
      maxFiles: '14d', // Keep logs for 14 days
      format: customFormat,
    }),
    // Error-only log file
    new DailyRotateFile({
      filename: path.join(__dirname, '../../data/hogbot-error-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      maxSize: '20m',
      maxFiles: '30d', // Keep error logs for 30 days
      format: customFormat,
    }),
  ],
});

/**
 * Sapphire-compatible logger wrapper
 * Bridges Winston logger to Sapphire's ILogger interface
 */
export class SapphireWinstonLogger implements ILogger {
  public has(level: LogLevel): boolean {
    const currentLevel = getLogLevel();
    return level >= currentLevel;
  }

  public trace(...values: readonly unknown[]): void {
    winstonLogger.debug(this.formatMessage(values));
  }

  public debug(...values: readonly unknown[]): void {
    winstonLogger.debug(this.formatMessage(values));
  }

  public info(...values: readonly unknown[]): void {
    winstonLogger.info(this.formatMessage(values));
  }

  public warn(...values: readonly unknown[]): void {
    winstonLogger.warn(this.formatMessage(values));
  }

  public error(...values: readonly unknown[]): void {
    winstonLogger.error(this.formatMessage(values));
  }

  public fatal(...values: readonly unknown[]): void {
    winstonLogger.error(this.formatMessage(values));
  }

  public write(level: LogLevel, ...values: readonly unknown[]): void {
    switch (level) {
      case LogLevel.Trace:
      case LogLevel.Debug:
        this.debug(...values);
        break;
      case LogLevel.Info:
        this.info(...values);
        break;
      case LogLevel.Warn:
        this.warn(...values);
        break;
      case LogLevel.Error:
        this.error(...values);
        break;
      case LogLevel.Fatal:
        this.fatal(...values);
        break;
      default:
        this.info(...values);
    }
  }

  private formatMessage(values: readonly unknown[]): string {
    return values
      .map((value) => {
        if (value instanceof Error) {
          return value.stack || value.message;
        }
        if (typeof value === 'object') {
          return JSON.stringify(value, null, 2);
        }
        return String(value);
      })
      .join(' ');
  }
}
