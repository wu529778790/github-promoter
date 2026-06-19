/**
 * 发送进度管理器
 *
 * 双写持久化：progress.json（快速查询）+ sent_emails.csv（持久记录）
 * 启动时从 CSV 重建已发送集合，防止重复发送
 *
 * 支持按产品去重：同一个邮箱推广不同产品可以重复发，同一产品不会重复发
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_DATA_DIR = join(__dirname, '..', 'data');

// ============================================================
// 类型定义
// ============================================================

export interface SenderStats {
  sent: number;
  failed: number;
  paused: boolean;
  pausedUntil: number | null;
}

export interface ProgressSnapshot {
  sent: number;
  failed: number;
  total: number;
  remaining: number;
  senderStats: Record<string, SenderStats>;
}

// ============================================================
// ProgressManager 类
// ============================================================

export class ProgressManager {
  /**
   * 按产品分组的已发送邮箱集合
   * key: product name, value: Set of emails
   */
  private sentByProduct: Map<string, Set<string>>;
  private senderStats: Map<string, SenderStats>;
  private total: number;
  private dataDir: string;
  private progressFile: string;
  private sentCsvFile: string;
  private sentLogFile: string;

  constructor(dataDir?: string) {
    this.sentByProduct = new Map();
    this.senderStats = new Map();
    this.total = 0;
    this.dataDir = dataDir || DEFAULT_DATA_DIR;
    this.progressFile = join(this.dataDir, 'progress.json');
    this.sentCsvFile = join(this.dataDir, 'sent_emails.csv');
    this.sentLogFile = join(this.dataDir, 'sent_log.csv');

    // 确保目录存在
    if (!existsSync(this.dataDir)) mkdirSync(this.dataDir, { recursive: true });

    // 从 CSV 重建已发送集合
    this.rebuildFromCsv();
  }

  /**
   * 标记邮件已发送
   */
  markSent(email: string, senderName: string, product: string): void {
    // 按产品记录
    let productSet = this.sentByProduct.get(product);
    if (!productSet) {
      productSet = new Set();
      this.sentByProduct.set(product, productSet);
    }
    productSet.add(email);

    // 更新发件人统计
    const stats = this.senderStats.get(senderName) || { sent: 0, failed: 0, paused: false, pausedUntil: null };
    stats.sent++;
    this.senderStats.set(senderName, stats);

    // 写入 CSV
    this.appendToSentCsv(email, senderName, product, 'sent');
  }

  /**
   * 标记邮件发送失败
   */
  markFailed(email: string, senderName: string, product: string, reason: string): void {
    const stats = this.senderStats.get(senderName) || { sent: 0, failed: 0, paused: false, pausedUntil: null };
    stats.failed++;
    this.senderStats.set(senderName, stats);

    this.appendToSentCsv(email, senderName, product, `failed: ${reason}`);
  }

  /**
   * 检查邮件是否已发送给某个产品
   * 只有同一产品才去重，不同产品可以重复发送
   */
  isSent(email: string, product: string): boolean {
    const productSet = this.sentByProduct.get(product);
    return productSet ? productSet.has(email) : false;
  }

  /**
   * 获取某个产品的已发送数量
   */
  getSentCount(product: string): number {
    const productSet = this.sentByProduct.get(product);
    return productSet ? productSet.size : 0;
  }

  /**
   * 获取所有产品的发送统计
   */
  getAllProductStats(): Record<string, number> {
    const stats: Record<string, number> = {};
    for (const [product, emails] of this.sentByProduct) {
      stats[product] = emails.size;
    }
    return stats;
  }

  /**
   * 设置发件人暂停状态
   */
  setSenderPaused(senderName: string, paused: boolean, until?: number): void {
    const stats = this.senderStats.get(senderName) || { sent: 0, failed: 0, paused: false, pausedUntil: null };
    stats.paused = paused;
    stats.pausedUntil = until || null;
    this.senderStats.set(senderName, stats);
  }

  /**
   * 重置每日统计（日期变更时调用）
   */
  resetDailyStats(): void {
    for (const [name, stats] of this.senderStats) {
      stats.sent = 0;
      stats.failed = 0;
      stats.paused = false;
      stats.pausedUntil = null;
    }
    this.senderStats.clear();
    this.save();
  }

  /**
   * 检查发件人是否暂停
   */
  isSenderPaused(senderName: string): boolean {
    const stats = this.senderStats.get(senderName);
    if (!stats || !stats.paused) return false;

    // 检查是否已过暂停时间
    if (stats.pausedUntil && Date.now() > stats.pausedUntil) {
      stats.paused = false;
      stats.pausedUntil = null;
      return false;
    }

    return true;
  }

  /**
   * 设置总邮件数
   */
  setTotal(total: number): void {
    this.total = total;
  }

  /**
   * 获取快照
   */
  getSnapshot(): ProgressSnapshot {
    // 总共发送数 = 所有产品的发送数之和
    let sent = 0;
    for (const emails of this.sentByProduct.values()) {
      sent += emails.size;
    }

    let failed = 0;
    for (const stats of this.senderStats.values()) {
      failed += stats.failed;
    }

    const senderStatsObj: Record<string, SenderStats> = {};
    for (const [name, stats] of this.senderStats) {
      senderStatsObj[name] = { ...stats };
    }

    return {
      sent,
      failed,
      total: this.total,
      remaining: this.total - sent,
      senderStats: senderStatsObj,
    };
  }

  /**
   * 持久化进度
   */
  save(): void {
    // 转换为可序列化的格式
    const sentByProductObj: Record<string, string[]> = {};
    for (const [product, emails] of this.sentByProduct) {
      sentByProductObj[product] = Array.from(emails);
    }

    const data = {
      sentByProduct: sentByProductObj,
      total: this.total,
      timestamp: new Date().toISOString(),
    };
    writeFileSync(this.progressFile, JSON.stringify(data, null, 2));
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /**
   * 从 CSV 重建已发送集合
   */
  private rebuildFromCsv(): void {
    // 从 sent_emails.csv 重建
    if (existsSync(this.sentCsvFile)) {
      try {
        const csv = readFileSync(this.sentCsvFile, 'utf-8');
        const lines = csv.split('\n').slice(1); // 跳过标题行
        for (const line of lines) {
          if (!line.trim()) continue;
          const parts = line.split(',').map(s => s.replace(/"/g, '').trim());
          const email = parts[0];
          const product = parts[2] || 'unknown'; // 旧格式没有 product 列

          if (email) {
            let productSet = this.sentByProduct.get(product);
            if (!productSet) {
              productSet = new Set();
              this.sentByProduct.set(product, productSet);
            }
            productSet.add(email);
          }
        }
      } catch {
        // 忽略
      }
    }

    // 从 sent_log.csv 重建
    if (existsSync(this.sentLogFile)) {
      try {
        const csv = readFileSync(this.sentLogFile, 'utf-8');
        const lines = csv.split('\n').slice(1);
        for (const line of lines) {
          if (!line.trim()) continue;
          const parts = line.split(',').map(s => s.replace(/"/g, '').trim());
          const email = parts[0];
          const product = parts[2] || 'unknown';

          if (email) {
            let productSet = this.sentByProduct.get(product);
            if (!productSet) {
              productSet = new Set();
              this.sentByProduct.set(product, productSet);
            }
            productSet.add(email);
          }
        }
      } catch {
        // 忽略
      }
    }

    // 从 progress.json 恢复（兼容新旧格式）
    if (existsSync(this.progressFile)) {
      try {
        const data = JSON.parse(readFileSync(this.progressFile, 'utf-8'));

        if (data.sentByProduct) {
          // 新格式：按产品分组
          for (const [product, emails] of Object.entries(data.sentByProduct)) {
            let productSet = this.sentByProduct.get(product);
            if (!productSet) {
              productSet = new Set();
              this.sentByProduct.set(product, productSet);
            }
            for (const email of emails as string[]) {
              productSet.add(email);
            }
          }
        } else if (data.sentEmails) {
          // 旧格式：全部归为 'unknown' 产品
          let productSet = this.sentByProduct.get('unknown');
          if (!productSet) {
            productSet = new Set();
            this.sentByProduct.set('unknown', productSet);
          }
          for (const email of data.sentEmails) {
            productSet.add(email);
          }
        }
      } catch {
        // 忽略
      }
    }
  }

  /**
   * 追加到发送记录 CSV
   */
  private appendToSentCsv(email: string, sender: string, product: string, status: string): void {
    // 确保 CSV 文件有标题
    if (!existsSync(this.sentCsvFile)) {
      writeFileSync(this.sentCsvFile, 'email,sender,product,status,timestamp\n');
    }

    const timestamp = new Date().toISOString();
    const line = `"${email}","${sender}","${product}","${status}","${timestamp}"\n`;
    appendFileSync(this.sentCsvFile, line);
  }
}
