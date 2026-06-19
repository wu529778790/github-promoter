/**
 * 多发件人并行发送引擎
 *
 * 参考 Python 项目的 ParallelSender 架构
 * - Queue + Worker 模型（无竞态条件）
 * - 每个发件人独立工作线程
 * - 限流隔离 + 任务重试
 * - 日期感知配额重置
 * - 优雅退出
 */

import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig, SenderConfig } from './config.js';
import { SmtpSender } from './smtp-sender.js';
import { ProgressManager } from './progress.js';
import { generateEmail } from './spintax.js';
import { getLogger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '..', 'data');
const EMAILS_FILE = join(DATA_DIR, 'emails.csv');

// ============================================================
// 任务队列（线程安全）
// ============================================================

interface EmailTask {
  email: string;
  name: string;
  retryCount: number;
  maxRetries: number;
}

class TaskQueue {
  private queue: EmailTask[] = [];
  private consumers: (() => void)[] = [];

  push(task: EmailTask): void {
    this.queue.push(task);
    // 唤醒一个等待的消费者
    const consumer = this.consumers.shift();
    if (consumer) consumer();
  }

  pop(timeoutMs = 5000): Promise<EmailTask | null> {
    // 如果队列非空，立即返回
    if (this.queue.length > 0) {
      return Promise.resolve(this.queue.shift() || null);
    }

    // 否则等待
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        // 移除消费者
        const idx = this.consumers.indexOf(consumerFn);
        if (idx !== -1) this.consumers.splice(idx, 1);
        resolve(null);
      }, timeoutMs);

      const consumerFn = () => {
        clearTimeout(timer);
        resolve(this.queue.shift() || null);
      };
      this.consumers.push(consumerFn);
    });
  }

  get size(): number {
    return this.queue.length;
  }

  requeue(task: EmailTask): void {
    this.queue.unshift(task); // 放回队首
  }

  clear(): void {
    this.queue = [];
  }
}

// ============================================================
// 并行发送器
// ============================================================

export class ParallelSender {
  private config: AppConfig;
  private progress: ProgressManager;
  private senders: SmtpSender[] = [];
  private queue = new TaskQueue();
  private aborted = false;
  private logger = getLogger();
  private lastQuotaResetDate: string = '';
  private workerPromises: Promise<void>[] = [];

  constructor(config: AppConfig) {
    this.config = config;
    this.progress = new ProgressManager();

    // 记录今天的日期（用于日期感知配额重置）
    this.lastQuotaResetDate = this.getDateString();

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
      this.logger.info('没有待发送的邮箱');
      return;
    }

    this.logger.info(`待发送: ${emails.length} 个邮箱`);
    this.logger.info(`推广产品: ${product}`);

    // 过滤已发送的（按产品去重）
    const pending = emails.filter(e => !this.progress.isSent(e.email, product));
    this.logger.info(`剩余: ${pending.length} 个邮箱 (已为 "${product}" 发送过 ${emails.length - pending.length} 个)`);

    if (pending.length === 0) {
      this.logger.info('所有邮件已发送完毕');
      return;
    }

    // 应用限制
    const toSend = limit ? pending.slice(0, limit) : pending;
    this.progress.setTotal(toSend.length);

    // 初始化发送器（过滤有密码的，且 status 不是 inactive 的）
    const activeSenders = this.config.senders.filter(s => s.password && s.status !== 'inactive');
    if (activeSenders.length === 0) {
      this.logger.error('没有有效的发件人配置');
      return;
    }

    this.logger.info(`启动 ${activeSenders.length} 个发件人并行发送...`);

    // 连接所有发送器
    for (const senderConfig of activeSenders) {
      const sender = new SmtpSender(senderConfig);
      const result = await sender.connect();
      if (result.success) {
        this.senders.push(sender);
      } else {
        this.logger.error(`发送器 ${sender.name} 连接失败: ${result.message}`);
      }
    }

    if (this.senders.length === 0) {
      this.logger.error('所有发送器连接失败');
      return;
    }

    this.logger.info(`${this.senders.length} 个发送器已连接`);

    // 将任务加入队列
    for (const emailData of toSend) {
      this.queue.push({
        email: emailData.email,
        name: emailData.name,
        retryCount: 0,
        maxRetries: 3,
      });
    }

    // 启动工作线程
    this.workerPromises = this.senders.map(sender => this.workerLoop(sender));

    // 等待所有工作线程完成
    await Promise.all(this.workerPromises);

    // 保存最终进度
    this.progress.save();

    // 显示最终统计
    const snapshot = this.progress.getSnapshot();
    this.logger.info(`最终统计: 已发送 ${snapshot.sent}, 失败 ${snapshot.failed}, 总计 ${snapshot.total}`);
  }

  /**
   * 停止发送（优雅退出）
   */
  async stop(): Promise<void> {
    this.logger.info('正在停止发送...');
    this.aborted = true;

    // 清空队列
    this.queue.clear();

    // 等待工作线程完成当前任务（最多 30 秒）
    const timeout = new Promise(resolve => setTimeout(resolve, 30000));
    await Promise.race([
      Promise.all(this.workerPromises),
      timeout,
    ]);

    // 断开所有连接
    for (const sender of this.senders) {
      await sender.disconnect();
    }

    // 保存进度
    this.progress.save();
    this.logger.info('进度已保存，发送已停止');
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
  // 工作线程
  // ============================================================

  private async workerLoop(sender: SmtpSender): Promise<void> {
    this.logger.info(`工作线程启动: ${sender.name}`);

    while (!this.aborted) {
      try {
        // 日期感知配额重置
        this.checkDateChange();

        // 检查发送器是否暂停
        if (this.progress.isSenderPaused(sender.name)) {
          this.logger.info(`${sender.name} 限流暂停中，等待恢复...`, sender.name);
          await this.sleep(60000);
          continue;
        }

        // 检查配额
        if (!sender.canSend()) {
          this.logger.info(`${sender.name} 配额已用完`, sender.name);
          break;
        }

        // 从队列获取任务
        const task = await this.queue.pop(5000);
        if (!task) continue; // 队列空，继续等待
        if (this.aborted) break;

        // 发送前检查是否已发送（防并发重复）
        const product = this.config.email_content.product_name;
        if (this.progress.isSent(task.email, product)) {
          continue;
        }

        // 生成随机内容
        const email = generateEmail(task.name);

        // 发送
        const result = await sender.send(task.email, email.subject, email.text);

        if (result.success) {
          this.progress.markSent(task.email, sender.name, product);
        } else if (result.isRateLimit) {
          this.logger.warn(`限流: ${task.email}`, sender.name);
          this.progress.setSenderPaused(sender.name, true, Date.now() + 12 * 60 * 60 * 1000);

          // 重试
          task.retryCount++;
          if (task.retryCount < task.maxRetries) {
            this.queue.requeue(task);
          } else {
            this.progress.markFailed(task.email, sender.name, product, 'rate_limited');
          }

          // 断开连接，等恢复后重连
          await sender.disconnect();
        } else {
          this.logger.error(`发送失败: ${task.email} - ${result.error}`, sender.name);
          this.progress.markFailed(task.email, sender.name, product, result.error || 'unknown');

          // 普通错误暂停 30 秒
          await this.sleep(30000);
        }

        // 随机延迟（从配置读取）
        if (!this.aborted) {
          const minDelay = this.config.settings.email_interval_min * 1000;
          const maxDelay = this.config.settings.email_interval_max * 1000;
          const delay = minDelay + Math.random() * (maxDelay - minDelay);

          // 分段延迟（可中断）
          const delayEnd = Date.now() + delay;
          while (Date.now() < delayEnd && !this.aborted) {
            await this.sleep(Math.min(30000, delayEnd - Date.now()));
          }
        }

        // 定期保存进度
        const snapshot = this.progress.getSnapshot();
        if (snapshot.sent % 10 === 0) {
          this.progress.save();
          this.logger.info(`进度: ${snapshot.sent}/${snapshot.total}`);
        }

      } catch (error) {
        this.logger.error(`工作线程异常: ${error}`, sender.name);
        await this.sleep(10000);
      }
    }

    // 清理
    await sender.disconnect();
    this.logger.info(`工作线程退出: ${sender.name}`);
  }

  // ============================================================
  // 日期感知配额重置
  // ============================================================

  private checkDateChange(): void {
    const today = this.getDateString();
    if (today !== this.lastQuotaResetDate) {
      this.logger.info(`日期变更: ${this.lastQuotaResetDate} → ${today}，重置所有配额`);
      for (const sender of this.senders) {
        sender.resetDailyQuota();
      }
      this.progress.resetDailyStats();
      this.lastQuotaResetDate = today;
    }
  }

  private getDateString(): string {
    return new Date().toISOString().split('T')[0];
  }

  // ============================================================
  // 工具方法
  // ============================================================

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

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private registerSignalHandlers(): void {
    const cleanup = async () => {
      if (!this.aborted) {
        await this.stop();
      }
      process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    process.on('exit', () => {
      this.progress.save();
    });
  }
}
