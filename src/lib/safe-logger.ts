import { container } from '@sapphire/framework';

/**
 * Safe logger that works both inside and outside Sapphire context
 * Falls back to console when container.logger is not available
 */
export const safeLogger = {
  info: (msg: string, ...args: any[]) => {
    try {
      if (container.logger) {
        container.logger.info(msg, ...args);
      } else {
        console.log(msg, ...args);
      }
    } catch {
      console.log(msg, ...args);
    }
  },
  warn: (msg: string, ...args: any[]) => {
    try {
      if (container.logger) {
        container.logger.warn(msg, ...args);
      } else {
        console.warn(msg, ...args);
      }
    } catch {
      console.warn(msg, ...args);
    }
  },
  error: (msg: string, ...args: any[]) => {
    try {
      if (container.logger) {
        container.logger.error(msg, ...args);
      } else {
        console.error(msg, ...args);
      }
    } catch {
      console.error(msg, ...args);
    }
  },
  debug: (msg: string, ...args: any[]) => {
    try {
      if (container.logger) {
        container.logger.debug(msg, ...args);
      } else {
        console.debug(msg, ...args);
      }
    } catch {
      console.debug(msg, ...args);
    }
  },
};
