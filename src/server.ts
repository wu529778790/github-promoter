/**
 * Web 管理界面
 *
 * 轻量级 Express 服务器，提供 Web UI 管理面板
 */

import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import YAML from 'yaml';
import { loadConfig, resetConfig } from './config.js';
import { generateEmail, getCombinationCount } from './spintax.js';
import { collectEmails, parseReposFromArgs } from './collect.js';
import { ParallelSender } from './sender.js';
import { SmtpSender } from './smtp-sender.js';
import { getLogger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WEB_DIR = join(__dirname, '..', 'web');
const CONFIG_PATH = join(__dirname, '..', 'config', 'config.yaml');
const ENV_PATH = join(__dirname, '..', '.env');
const EMAILS_FILE = join(__dirname, '..', 'data', 'emails.csv');

const app = express();
const logger = getLogger();
const PORT = parseInt(process.env.WEB_PORT || '3456', 10);

// 中间件
app.use(express.json());
app.use(express.static(WEB_DIR));

// ============================================================
// API: 初始化检查
// ============================================================

app.get('/api/setup', (req, res) => {
  const hasConfig = existsSync(CONFIG_PATH);
  const hasEnv = existsSync(ENV_PATH);
  res.json({
    ok: true,
    data: {
      needsSetup: !hasConfig && !hasEnv,
      hasConfig,
      hasEnv,
    },
  });
});

// ============================================================
// API: 配置状态检查（按需配置）
// ============================================================

function parseEnvFile(): Record<string, string> {
  if (!existsSync(ENV_PATH)) return {};
  try {
    const content = readFileSync(ENV_PATH, 'utf-8');
    const result: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        result[key] = val;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function writeEnvFile(updates: Record<string, string>) {
  const existing = parseEnvFile();
  const merged = { ...existing, ...updates };
  const lines = [
    `# GitHub Token`,
    `GITHUB_TOKEN=${merged.GITHUB_TOKEN || ''}`,
    ``,
    `# SMTP 邮箱配置`,
    `SMTP_HOST=${merged.SMTP_HOST || 'smtp.qq.com'}`,
    `SMTP_PORT=${merged.SMTP_PORT || '465'}`,
    `SMTP_USER=${merged.SMTP_USER || ''}`,
    `SMTP_PASS=${merged.SMTP_PASS || ''}`,
    `SMTP_DAILY_LIMIT=${merged.SMTP_DAILY_LIMIT || '200'}`,
    ``,
    `# 产品信息`,
    `PRODUCT_NAME=${merged.PRODUCT_NAME || ''}`,
    `PRODUCT_DESC=${merged.PRODUCT_DESC || ''}`,
    `GITHUB_REPO=${merged.GITHUB_REPO || ''}`,
    ``,
    `# 调试`,
    `DRY_RUN=${merged.DRY_RUN || 'false'}`,
    `LOG_LEVEL=${merged.LOG_LEVEL || 'info'}`,
  ];
  writeFileSync(ENV_PATH, lines.join('\n'));
}

app.get('/api/setup/status', (_req, res) => {
  const env = parseEnvFile();
  res.json({
    ok: true,
    data: {
      github_token: !!env.GITHUB_TOKEN,
      smtp: !!(env.SMTP_USER && env.SMTP_PASS),
      product: !!env.PRODUCT_NAME,
    },
  });
});

app.post('/api/setup/github-token', (req, res) => {
  try {
    const { github_token } = req.body;
    if (!github_token) {
      return res.json({ ok: false, error: '请填写 GitHub Token' });
    }
    writeEnvFile({ GITHUB_TOKEN: github_token });
    resetConfig();
    res.json({ ok: true, message: 'GitHub Token 已保存' });
  } catch (error: any) {
    res.json({ ok: false, error: error.message });
  }
});

app.post('/api/setup/smtp', (req, res) => {
  try {
    const { smtp_host, smtp_port, smtp_user, smtp_pass } = req.body;
    if (!smtp_user || !smtp_pass) {
      return res.json({ ok: false, error: '请填写邮箱和密码/授权码' });
    }
    writeEnvFile({
      SMTP_HOST: smtp_host || 'smtp.qq.com',
      SMTP_PORT: smtp_port || '465',
      SMTP_USER: smtp_user,
      SMTP_PASS: smtp_pass,
    });
    resetConfig();
    res.json({ ok: true, message: 'SMTP 配置已保存' });
  } catch (error: any) {
    res.json({ ok: false, error: error.message });
  }
});

app.post('/api/setup/product', (req, res) => {
  try {
    const { product_name, product_desc, github_repo } = req.body;
    if (!product_name) {
      return res.json({ ok: false, error: '请填写产品名称' });
    }
    writeEnvFile({
      PRODUCT_NAME: product_name,
      PRODUCT_DESC: product_desc || '',
      GITHUB_REPO: github_repo || '',
    });
    resetConfig();
    res.json({ ok: true, message: '产品信息已保存' });
  } catch (error: any) {
    res.json({ ok: false, error: error.message });
  }
});

// ============================================================
// API: 保存 .env（兼容旧接口）
// ============================================================

app.post('/api/setup/env', (req, res) => {
  try {
    const {
      github_token, smtp_host, smtp_port, smtp_user, smtp_pass,
      product_name, product_desc, github_repo,
    } = req.body;
    const lines = [
      `# GitHub Token`,
      `GITHUB_TOKEN=${github_token || ''}`,
      ``,
      `# SMTP 邮箱配置`,
      `SMTP_HOST=${smtp_host || 'smtp.qq.com'}`,
      `SMTP_PORT=${smtp_port || '465'}`,
      `SMTP_USER=${smtp_user || ''}`,
      `SMTP_PASS=${smtp_pass || ''}`,
      `SMTP_DAILY_LIMIT=200`,
      ``,
      `# 产品信息`,
      `PRODUCT_NAME=${product_name || 'My Project'}`,
      `PRODUCT_DESC=${product_desc || 'A great open source project'}`,
      `GITHUB_REPO=${github_repo || ''}`,
      ``,
      `# 调试`,
      `DRY_RUN=false`,
      `LOG_LEVEL=info`,
    ];
    writeFileSync(ENV_PATH, lines.join('\n'));
    resetConfig();
    res.json({ ok: true, message: '.env 已保存' });
  } catch (error: any) {
    res.json({ ok: false, error: error.message });
  }
});

// ============================================================
// API: 获取状态
// ============================================================

app.get('/api/status', (req, res) => {
  try {
    const config = loadConfig();
    const emailCount = getEmailCount();
    const productStats = getProductStats();

    res.json({
      ok: true,
      data: {
        emailCount,
        product: config.email_content,
        senders: config.senders.map(s => ({
          name: s.name,
          email: s.email,
          server: s.smtp_server,
          status: s.status || 'active',
        })),
        sources: config.harvest.sources || ['stargazers'],
        topics: config.harvest.topics,
        repos: config.harvest.target_repos,
        settings: config.settings,
        debug: config.debug,
        combinationCount: getCombinationCount(),
        productStats,
      },
    });
  } catch (error: any) {
    res.json({ ok: false, error: error.message });
  }
});

// ============================================================
// API: 获取配置（config.yaml）
// ============================================================

app.get('/api/config', (req, res) => {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = readFileSync(CONFIG_PATH, 'utf-8');
      const config = YAML.parse(raw);
      res.json({ ok: true, data: config });
    } else {
      res.json({ ok: true, data: null, message: '未找到 config.yaml' });
    }
  } catch (error: any) {
    res.json({ ok: false, error: error.message });
  }
});

// ============================================================
// API: 获取/保存 .env 文件
// ============================================================

app.get('/api/env', (_req, res) => {
  try {
    if (existsSync(ENV_PATH)) {
      const raw = readFileSync(ENV_PATH, 'utf-8');
      res.json({ ok: true, data: raw });
    } else {
      res.json({ ok: true, data: '', message: '未找到 .env 文件' });
    }
  } catch (error: any) {
    res.json({ ok: false, error: error.message });
  }
});

app.post('/api/env', (req, res) => {
  try {
    const { content } = req.body;
    if (typeof content !== 'string') {
      return res.json({ ok: false, error: '内容格式错误' });
    }
    writeFileSync(ENV_PATH, content);
    resetConfig();
    res.json({ ok: true, message: '.env 已保存' });
  } catch (error: any) {
    res.json({ ok: false, error: error.message });
  }
});

// ============================================================
// API: 保存配置
// ============================================================

app.post('/api/config', (req, res) => {
  try {
    const config = req.body;
    const yaml = YAML.stringify(config);
    writeFileSync(CONFIG_PATH, yaml);
    resetConfig(); // 清除缓存
    res.json({ ok: true, message: '配置已保存' });
  } catch (error: any) {
    res.json({ ok: false, error: error.message });
  }
});

// ============================================================
// API: 预览邮件
// ============================================================

app.get('/api/preview', (req, res) => {
  try {
    const count = parseInt(req.query.count as string) || 5;
    const config = loadConfig();
    const product = config.email_content;
    const sampleNames = ['Alice', 'Bob', '张三', '李四', 'Developer', ''];

    const emails = [];
    for (let i = 0; i < count; i++) {
      const name = sampleNames[i % sampleNames.length];
      const email = generateEmail(name, product);
      emails.push({ index: i + 1, recipient: name || '无名', ...email });
    }

    res.json({ ok: true, data: emails });
  } catch (error: any) {
    res.json({ ok: false, error: error.message });
  }
});

// ============================================================
// API: 开始采集
// ============================================================

let collecting = false;

app.post('/api/collect', async (req, res) => {
  if (collecting) {
    return res.json({ ok: false, error: '采集正在进行中' });
  }

  const { repo } = req.body || {};
  collecting = true;

  try {
    const config = loadConfig();
    const flags: string[] = [];
    if (repo) {
      flags.push('--repo', repo);
    }
    await collectEmails(config, flags);
    collecting = false;
    res.json({ ok: true, message: '采集完成' });
  } catch (error: any) {
    collecting = false;
    res.json({ ok: false, error: error.message });
  }
});

// ============================================================
// API: 开始发送（模拟）
// ============================================================

let sending = false;

app.post('/api/send', async (req, res) => {
  if (sending) {
    return res.json({ ok: false, error: '发送正在进行中' });
  }

  const { dryRun, limit } = req.body || {};
  sending = true;

  try {
    const config = loadConfig();
    if (dryRun) config.debug.dry_run = true;

    const sender = new ParallelSender(config);
    // 后台运行，不阻塞响应
    sender.start(limit).then(() => { sending = false; });
    res.json({ ok: true, message: dryRun ? '模拟发送已启动' : '发送已启动' });
  } catch (error: any) {
    sending = false;
    res.json({ ok: false, error: error.message });
  }
});

// ============================================================
// API: 测试 SMTP 连接
// ============================================================

app.post('/api/test-smtp', async (req, res) => {
  try {
    const config = loadConfig();
    const results = [];

    for (const sender of config.senders) {
      const smtp = new SmtpSender({
        name: sender.name,
        email: sender.email,
        smtp_server: sender.smtp_server,
        smtp_port: sender.smtp_port,
        password: sender.password,
        daily_limit: sender.daily_limit,
      });

      const result = await smtp.connect();
      await smtp.disconnect();
      results.push({
        name: sender.name,
        email: sender.email,
        ...result,
      });
    }

    res.json({ ok: true, data: results });
  } catch (error: any) {
    res.json({ ok: false, error: error.message });
  }
});

// ============================================================
// API: 获取日志
// ============================================================

app.get('/api/logs', (req, res) => {
  try {
    const logFile = join(__dirname, '..', 'logs', 'promoter.log');
    if (!existsSync(logFile)) {
      return res.json({ ok: true, data: [] });
    }
    const content = readFileSync(logFile, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim()).slice(-100); // 最近 100 行
    res.json({ ok: true, data: lines });
  } catch (error: any) {
    res.json({ ok: false, error: error.message });
  }
});

// ============================================================
// API: 获取发送状态
// ============================================================

app.get('/api/send-status', (req, res) => {
  try {
    const config = loadConfig();
    const emailCount = getEmailCount();
    const productStats = getProductStats();

    res.json({
      ok: true,
      data: {
        isCollecting: collecting,
        isSending: sending,
        emailCount,
        productStats,
      },
    });
  } catch (error: any) {
    res.json({ ok: false, error: error.message });
  }
});

// ============================================================
// 工具函数
// ============================================================

function getEmailCount(): number {
  if (!existsSync(EMAILS_FILE)) return 0;
  try {
    const csv = readFileSync(EMAILS_FILE, 'utf-8');
    return csv.split('\n').length - 1;
  } catch {
    return 0;
  }
}

function getProductStats(): Record<string, number> {
  if (!existsSync(EMAILS_FILE)) return {};
  try {
    const csv = readFileSync(EMAILS_FILE, 'utf-8');
    const lines = csv.split('\n').slice(1).filter(l => l.trim());
    const stats: Record<string, number> = {};
    for (const line of lines) {
      const parts = line.split(',').map(s => s.replace(/"/g, '').trim());
      const source = parts[3] || 'unknown';
      const type = source.split(':')[0];
      stats[type] = (stats[type] || 0) + 1;
    }
    return stats;
  } catch {
    return {};
  }
}

// ============================================================
// 启动服务器
// ============================================================

export function startServer(): void {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🌐 管理界面已启动`);
    console.log(`   地址: http://localhost:${PORT}`);
    console.log(`   API:  http://localhost:${PORT}/api/status\n`);
  });
}

// 如果直接运行此文件
if (process.argv[1] && process.argv[1].endsWith('server.ts')) {
  startServer();
}
