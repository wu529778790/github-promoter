/**
 * 多发件人并行发送引擎
 *
 * 特性：
 * - 多 SMTP 账号并行发送
 * - 每个发件人独立配额追踪
 * - 限流隔离（一个账号限流不影响其他）
 * - 每日配额自动重置
 * - 连接活性检测（NOOP）
 * - 连接重试（3 次，指数退避）
 * - 优雅退出（SIGINT/SIGTERM → 保存进度 → 退出）
 */

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig, SenderConfig } from './config.js';
import { ProgressManager } from './progress.js';
import { generateEmail } from './spintax.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '..', 'data');
const EMAILS_FILE = join(DATA_DIR, 'emails.csv');

// ============================================================
// SMTP 连接管理
// ============================================================

class SmtpConnection {
  private transporter: Transporter | null = null;
  private config: SenderConfig;
  private failedQueue: string[] = [];

  constructor(config: SenderConfig) {
    this.config = config;
  }

  /**
   * 建立连接
   */
  async connect(): Promise<void> {
    this.transporter = nodemailer.createTransport({
      host: this.config.smtp_server,
      port: this.config.smtp_port,
      secure: this.config.smtp_port === 465,
      auth: {
        user: this.config.email,
        pass: this.config.password,
      },
      // 连接超时 30 秒
      connectionTimeout: 30000,
      // 读取超时 30 秒
      greetingTimeout: 30000,
    });
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
  }

  /**
   * 检查连接活性（NOOP）
   */
  async isAlive(): Promise<boolean> {
    if (!this.transporter) return false;
    try {
      await this.transporter.verify();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 确保连接可用（断线重连）
   */
  async ensureConnection(): Promise<void> {
    if (!this.transporter || !(await this.isAlive())) {
      await this.disconnect();
      await this.connect();
    }
  }

  /**
   * 发送邮件（带重试）
   */
  async send(
    from: string,
    to: string,
    subject: string,
    text: string
  ): Promise<{ success: boolean; error?: string }> {
    const MAX_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await this.ensureConnection();
        await this.transporter!.sendMail({ from, to, subject, text });
        return { success: true };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);

        // 限流错误码：421, 450, 550, 571, 69585
        const isRateLimit = /421|450|550|571|69585/.test(errMsg) ||
          errMsg.includes('quota') ||
          errMsg.includes('too many') ||
          errMsg.includes('rate limit');

        if (isRateLimit) {
          return { success: false, error: `RATE_LIMIT: ${errMsg}` };
        }

        // 非限流错误：重试
        if (attempt < MAX_RETRIES) {
          const backoff = attempt * 5000; // 5s, 10s, 15s
          console.log(`   ⚠️ 发送失败 (${attempt}/${MAX_RETRIES})，${backoff / 1000} 秒后重试...`);
          await new Promise(resolve => setTimeout(resolve, backoff));
        } else {
          return { success: false, error: errMsg };
        }
      }
    }

    return { success: false, error: 'Max retries exceeded' };
  }
}

// ============================================================
// 并行发送器
// ============================================================

export class ParallelSender {
  private config: AppConfig;
  private progress: ProgressManager;
  private connections: Map<string, SmtpConnection> = new Map();
  private aborted = false;

  constructor(config: AppConfig) {
    this.config = config;
    this.progress = new ProgressManager();

    // 注册信号处理
    this.registerSignalHandlers();
  }

  /**
   * 启动并行发送
   */
  async start(limit?: number): Promise<void> {
    const product = this.config.email_content.product_name;

    // 读取邮箱列表
    const emails = this.loadEmails();
    if (emails.length === 0) {
      console.log('📭 没有待发送的邮箱');
      return;
    }

    console.log(`📧 待发送: ${emails.length} 个邮箱`);
    console.log(`📦 推广产品: ${product}`);

    // 过滤已发送的（按产品去重）
    const pending = emails.filter(e => !this.progress.isSent(e.email, product));
    console.log(`📬 剩余: ${pending.length} 个邮箱 (已为 "${product}" 发送过 ${emails.length - pending.length} 个)`);

    if (pending.length === 0) {
      console.log('✅ 所有邮件已发送完毕');
      return;
    }

    // 应用限制
    const toSend = limit ? pending.slice(0, limit) : pending;
    this.progress.setTotal(toSend.length);
    this.progress.save();

    // 初始化 SMTP 连接
    const activeSenders = this.config.senders.filter(s => s.password); // 过滤有密码的
    if (activeSenders.length === 0) {
      console.error('❌ 没有有效的发件人配置');
      return;
    }

    console.log(`\n🚀 启动 ${activeSenders.length} 个发件人并行发送...\n`);

    for (const sender of activeSenders) {
      const conn = new SmtpConnection(sender);
      this.connections.set(sender.name, conn);
      await conn.connect();
    }

    // 并行发送
    await this.sendParallel(toSend, activeSenders);

    // 清理
    for (const conn of this.connections.values()) {
      await conn.disconnect();
    }

    // 显示最终统计
    const snapshot = this.progress.getSnapshot();
    console.log(`\n📊 最终统计:`);
    console.log(`   ✅ 已发送: ${snapshot.sent}`);
    console.log(`   ❌ 失败: ${snapshot.failed}`);
    console.log(`   📧 总计: ${snapshot.total}`);
  }

  /**
   * 停止发送（优雅退出）
   */
  async stop(): Promise<void> {
    console.log('\n⏹️ 正在停止发送...');
    this.aborted = true;

    // 等待当前发送完成
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 保存进度
    this.progress.save();

    // 断开连接
    for (const conn of this.connections.values()) {
      await conn.disconnect();
    }

    console.log('💾 进度已保存');
  }

  /**
   * 显示状态
   */
  showStatus(): void {
    const snapshot = this.progress.getSnapshot();
    const productStats = this.progress.getAllProductStats();
    const currentProduct = this.config.email_content.product_name;

    console.log('📊 发送状态:\n');
    console.log(`   📦 当前产品: ${currentProduct}`);
    console.log(`   📧 总计: ${snapshot.total}`);
    console.log(`   ✅ 已发送: ${snapshot.sent}`);
    console.log(`   ❌ 失败: ${snapshot.failed}`);
    console.log(`   📬 剩余: ${snapshot.remaining}`);

    // 各产品发送统计
    if (Object.keys(productStats).length > 0) {
      console.log('\n   各产品发送记录:');
      for (const [product, count] of Object.entries(productStats)) {
        console.log(`   - ${product}: ${count} 个邮箱`);
      }
    }

    if (Object.keys(snapshot.senderStats).length > 0) {
      console.log('\n   发件人详情:');
      for (const [name, stats] of Object.entries(snapshot.senderStats)) {
        const status = stats.paused ? '⏸️ 暂停中' : '🟢 活跃';
        console.log(`   - ${name}: ${status} (发送 ${stats.sent}, 失败 ${stats.failed})`);
      }
    }
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /**
   * 并行发送核心逻辑
   */
  private async sendParallel(
    emails: { email: string; name: string }[],
    senders: SenderConfig[]
  ): Promise<void> {
    const product = this.config.email_content.product_name;
    let currentIndex = 0;

    // 为每个发件人创建工作循环
    const workers = senders.map(async (sender) => {
      const conn = this.connections.get(sender.name)!;

      while (currentIndex < emails.length && !this.aborted) {
        // 检查发件人是否暂停
        if (this.progress.isSenderPaused(sender.name)) {
          console.log(`⏸️ ${sender.name} 已暂停，等待...`);
          await new Promise(resolve => setTimeout(resolve, 60000)); // 1 分钟后重试
          continue;
        }

        // 获取下一个邮箱（简单锁）
        if (currentIndex >= emails.length) break;
        const emailData = emails[currentIndex++];

        // 随机延迟
        const minDelay = this.config.settings.email_interval_min * 1000;
        const maxDelay = this.config.settings.email_interval_max * 1000;
        const delay = minDelay + Math.random() * (maxDelay - minDelay);

        // 分段延迟（每 30 秒检查一次是否需要退出）
        const delayEnd = Date.now() + delay;
        while (Date.now() < delayEnd && !this.aborted) {
          await new Promise(resolve => setTimeout(resolve, Math.min(30000, delayEnd - Date.now())));
        }
        if (this.aborted) break;

        // DRY RUN
        if (this.config.debug.dry_run) {
          console.log(`🧪 [DRY RUN] 跳过: ${emailData.email} (${sender.name})`);
          this.progress.markSent(emailData.email, sender.name, product);
          continue;
        }

        // 生成随机内容
        const email = generateEmail(emailData.name);

        // 发送
        const from = `"${sender.name}" <${sender.email}>`;
        const result = await conn.send(from, emailData.email, email.subject, email.text);

        if (result.success) {
          console.log(`✅ ${sender.name} → ${emailData.email}`);
          this.progress.markSent(emailData.email, sender.name, product);
        } else if (result.error?.startsWith('RATE_LIMIT:')) {
          console.log(`⏸️ ${sender.name} 触发限流，暂停 12 小时`);
          this.progress.setSenderPaused(sender.name, true, Date.now() + 12 * 60 * 60 * 1000);
          this.progress.markFailed(emailData.email, sender.name, product, 'rate_limited');
          // 把邮箱放回队列
          currentIndex--;
        } else {
          console.log(`❌ ${sender.name} → ${emailData.email}: ${result.error}`);
          this.progress.markFailed(emailData.email, sender.name, product, result.error || 'unknown');
        }

        // 定期保存进度
        const snapshot = this.progress.getSnapshot();
        if (snapshot.sent % 10 === 0) {
          this.progress.save();
          console.log(`📊 进度: ${snapshot.sent}/${snapshot.total}`);
        }
      }
    });

    await Promise.all(workers);
    this.progress.save();
  }

  /**
   * 读取邮箱列表
   */
  private loadEmails(): { email: string; name: string }[] {
    if (!existsSync(EMAILS_FILE)) return [];

    try {
      const csv = readFileSync(EMAILS_FILE, 'utf-8');
      const lines = csv.split('\n').slice(1);
      return lines
        .map(line => {
          if (!line.trim()) return null;
          const [email, , name] = line.split(',').map(s => s.replace(/"/g, '').trim());
          return email ? { email, name: name || '开发者' } : null;
        })
        .filter((e): e is { email: string; name: string } => e !== null);
    } catch {
      return [];
    }
  }

  /**
   * 注册信号处理（优雅退出）
   */
  private registerSignalHandlers(): void {
    const cleanup = async () => {
      if (!this.aborted) {
        await this.stop();
      }
      process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  }
}
