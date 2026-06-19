/**
 * 文件日志系统
 *
 * 参考 Python 项目的 RotatingFileHandler 实现
 * 支持文件轮转 + 控制台输出
 */

import { writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_LOG_DIR = join(__dirname, '..', 'logs');

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

class Logger {
  private logDir: string;
  private logFile: string;
  private level: LogLevel;
  private maxFileSize = 10 * 1024 * 1024; // 10MB
  private maxFiles = 5;

  constructor(level: LogLevel = 'info', logDir?: string) {
    this.level = level;
    this.logDir = logDir || DEFAULT_LOG_DIR;
    this.logFile = join(this.logDir, 'promoter.log');

    if (!existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true });
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.level];
  }

  private formatMessage(level: LogLevel, sender: string, message: string): string {
    const timestamp = new Date().toISOString();
    const prefix = sender ? `[${sender}]` : '';
    return `${timestamp} [${level.toUpperCase()}] ${prefix} ${message}\n`;
  }

  private rotateIfNeeded(): void {
    if (!existsSync(this.logFile)) return;

    try {
      const stat = statSync(this.logFile);
      if (stat.size >= this.maxFileSize) {
        // 轮转：删除最旧的，重命名现有的
        for (let i = this.maxFiles - 1; i >= 1; i--) {
          const oldFile = `${this.logFile}.${i}`;
          const newFile = `${this.logFile}.${i + 1}`;
          if (existsSync(oldFile)) {
            if (i === this.maxFiles - 1) {
              unlinkSync(oldFile); // 删除最旧的
            } else {
              renameSync(oldFile, newFile);
            }
          }
        }
        renameSync(this.logFile, `${this.logFile}.1`);
      }
    } catch {
      // 忽略轮转错误
    }
  }

  private write(level: LogLevel, sender: string, message: string): void {
    if (!this.shouldLog(level)) return;

    const formatted = this.formatMessage(level, sender, message);

    // 控制台输出
    if (level === 'error') {
      process.stderr.write(formatted);
    } else {
      process.stdout.write(formatted);
    }

    // 文件输出
    try {
      this.rotateIfNeeded();
      appendFileSync(this.logFile, formatted);
    } catch {
      // 忽略文件写入错误
    }
  }

  debug(message: string, sender?: string): void {
    this.write('debug', sender || '', message);
  }

  info(message: string, sender?: string): void {
    this.write('info', sender || '', message);
  }

  warn(message: string, sender?: string): void {
    this.write('warn', sender || '', message);
  }

  error(message: string, sender?: string): void {
    this.write('error', sender || '', message);
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }
}

// 单例
let _logger: Logger | null = null;

export function getLogger(level?: LogLevel, logDir?: string): Logger {
  if (!_logger) {
    _logger = new Logger(level, logDir);
  }
  return _logger;
}

export function resetLogger(): void {
  _logger = null;
}
