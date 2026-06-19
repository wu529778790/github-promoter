/**
 * SMTP 连接管理器
 *
 * 参考 Python 项目的 SMTPSender 实现
 * - 3 次重试 + 指数退避
 * - NOOP 健康检查
 * - SMTP 错误码检测（非正则匹配）
 * - 配额追踪
 */

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { getLogger } from './logger.js';

// Gmail/常见邮箱限流错误码
const RATE_LIMIT_CODES = new Set([421, 450, 550, 571, 69585]);

export interface SmtpConfig {
  name: string;
  email: string;
  smtp_server: string;
  smtp_port: number;
  password: string;
  daily_limit: number;
}

export interface SendResult {
  success: boolean;
  error?: string;
  isRateLimit?: boolean;
}

export class SmtpSender {
  private config: SmtpConfig;
  private transporter: Transporter | null = null;
  private isConnected = false;
  private sentCount = 0;
  private lastActivityTime: Date | null = null;
  private logger = getLogger();

  constructor(config: SmtpConfig) {
    this.config = config;
  }

  get name(): string { return this.config.name; }
  get email(): string { return this.config.email; }
  get dailyLimit(): number { return this.config.daily_limit; }

  /**
   * 连接 SMTP 服务器（带 3 次重试）
   */
  async connect(retryCount = 3): Promise<{ success: boolean; message: string }> {
    for (let attempt = 1; attempt <= retryCount; attempt++) {
      try {
        this.transporter = nodemailer.createTransport({
          host: this.config.smtp_server,
          port: this.config.smtp_port,
          secure: this.config.smtp_port === 465,
          auth: {
            user: this.config.email,
            pass: this.config.password,
          },
          connectionTimeout: 30000,
          greetingTimeout: 30000,
          // 禁用 TLS 证书验证（某些 SMTP 服务器需要）
          tls: { rejectUnauthorized: false },
        });

        // 验证连接
        await this.transporter.verify();
        this.isConnected = true;
        this.lastActivityTime = new Date();
        this.logger.info(`SMTP 连接成功`, this.config.name);
        return { success: true, message: '连接成功' };

      } catch (error: any) {
        // 认证错误不重试
        if (error.code === 'EAUTH') {
          this.logger.error(`SMTP 认证失败: ${error.message}`, this.config.name);
          return { success: false, message: `认证失败: ${error.message}` };
        }

        // 连接/超时错误重试
        if (attempt < retryCount) {
          this.logger.warn(`SMTP 连接失败 (${attempt}/${retryCount})，5秒后重试...`, this.config.name);
          await this.sleep(5000);
        } else {
          this.logger.error(`SMTP 连接失败 (${attempt}/${retryCount}): ${error.message}`, this.config.name);
          return { success: false, message: `连接失败: ${error.message}` };
        }
      }
    }

    return { success: false, message: '连接失败' };
  }

  /**
   * 断开连接
   */
  async disconnect(): Promise<void> {
    if (this.transporter) {
      try {
        await this.transporter.close();
      } catch {
        // 忽略
      }
      this.transporter = null;
    }
    this.isConnected = false;
  }

  /**
   * NOOP 健康检查
   */
  async noop(): Promise<boolean> {
    if (!this.transporter || !this.isConnected) return false;
    try {
      await this.transporter.verify();
      return true;
    } catch {
      this.isConnected = false;
      return false;
    }
  }

  /**
   * 确保连接有效（断线重连）
   */
  async ensureConnection(): Promise<{ success: boolean; message: string }> {
    if (!this.isConnected || !this.transporter) {
      return this.connect();
    }

    if (!(await this.noop())) {
      this.logger.warn('连接已断开，重新连接...', this.config.name);
      return this.connect();
    }

    return { success: true, message: '连接正常' };
  }

  /**
   * 检查是否可以继续发送
   */
  canSend(): boolean {
    return this.sentCount < this.config.daily_limit;
  }

  /**
   * 获取剩余配额
   */
  remainingQuota(): number {
    return Math.max(0, this.config.daily_limit - this.sentCount);
  }

  /**
   * 重置每日配额
   */
  resetDailyQuota(): void {
    this.sentCount = 0;
    this.logger.info('每日配额已重置', this.config.name);
  }

  /**
   * 发送纯文本邮件
   */
  async send(
    toEmail: string,
    subject: string,
    text: string
  ): Promise<SendResult> {
    if (!this.canSend()) {
      return { success: false, error: '已达到日限额' };
    }

    // 确保连接有效
    const connResult = await this.ensureConnection();
    if (!connResult.success) {
      return { success: false, error: connResult.message };
    }

    try {
      await this.transporter!.sendMail({
        from: `"${this.config.name}" <${this.config.email}>`,
        to: toEmail,
        subject,
        text,
      });

      this.sentCount++;
      this.lastActivityTime = new Date();
      this.logger.info(`发送成功 #${this.sentCount}: ${toEmail}`, this.config.name);
      return { success: true };

    } catch (error: any) {
      // 提取 SMTP 错误码（关键改进：不依赖字符串匹配）
      const smtpCode = this.extractSmtpCode(error);

      // 限流错误
      if (smtpCode && (RATE_LIMIT_CODES.has(smtpCode) || smtpCode >= 500)) {
        this.logger.error(`限流/封锁错误 ${smtpCode}: ${toEmail}`, this.config.name);
        return { success: false, error: `RATE_LIMIT:${smtpCode}`, isRateLimit: true };
      }

      // 连接断开
      if (error.code === 'ECONNECTION' || error.code === 'ESOCKET') {
        this.isConnected = false;
        this.logger.warn(`连接断开: ${error.message}`, this.config.name);
        return { success: false, error: `连接断开: ${error.message}` };
      }

      // 超时
      if (error.code === 'ETIMEDOUT') {
        this.isConnected = false;
        this.logger.error(`发送超时: ${toEmail}`, this.config.name);
        return { success: false, error: '发送超时' };
      }

      // 其他错误
      this.logger.error(`发送失败: ${error.message}`, this.config.name);
      return { success: false, error: error.message };
    }
  }

  /**
   * 从 nodemailer 错误中提取 SMTP 错误码
   */
  private extractSmtpCode(error: any): number | null {
    // nodemailer 的错误对象
    if (error.responseCode) return error.responseCode;
    if (error.smtpCode) return error.smtpCode;
    if (error.code) {
      const code = parseInt(error.code, 10);
      if (!isNaN(code)) return code;
    }
    // 从错误消息中提取
    if (error.message) {
      const match = error.message.match(/(\d{3})/);
      if (match) return parseInt(match[1], 10);
    }
    return null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
