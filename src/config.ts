/**
 * 配置加载器
 *
 * 优先读取 config/config.yaml，回退到环境变量
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');

// ============================================================
// 类型定义
// ============================================================

export interface SenderConfig {
  name: string;
  email: string;
  smtp_server: string;
  smtp_port: number;
  password: string;
  daily_limit: number;
  status?: string; // active / inactive
}

export interface SettingsConfig {
  email_interval_min: number;
  email_interval_max: number;
  timezone: string;
}

export interface HarvestConfig {
  topics: string[];
  target_repos: string[];
  per_repo_limit: number;
  rate_limit_threshold: number;
  sources: string[];
}

export interface EmailContentConfig {
  product_name: string;
  product_description: string;
  github_repo_url: string;
}

export interface DebugConfig {
  dry_run: boolean;
  log_level: string;
}

export interface AppConfig {
  senders: SenderConfig[];
  settings: SettingsConfig;
  harvest: HarvestConfig;
  email_content: EmailContentConfig;
  debug: DebugConfig;
}

// ============================================================
// 默认配置
// ============================================================

const DEFAULT_CONFIG: AppConfig = {
  senders: [],
  settings: {
    email_interval_min: 180,
    email_interval_max: 420,
    timezone: 'Asia/Shanghai',
  },
  harvest: {
    topics: ['ai-tool', 'claude', 'llm'],
    target_repos: [],
    per_repo_limit: 100,
    rate_limit_threshold: 100,
    sources: ['stargazers', 'issues', 'pulls', 'forks'],
  },
  email_content: {
    product_name: 'My Project',
    product_description: 'A great open source project',
    github_repo_url: '',
  },
  debug: {
    dry_run: false,
    log_level: 'info',
  },
};

// ============================================================
// 配置加载
// ============================================================

let _config: AppConfig | null = null;

/**
 * 加载配置（优先 .env，可选 config.yaml 补充）
 */
export function loadConfig(configPath?: string): AppConfig {
  if (_config) return _config;

  // 1. 从 .env 构建基础配置
  _config = configFromEnv();

  // 2. 如果有 config.yaml，合并高级配置（可选）
  const yamlPath = configPath || join(PROJECT_ROOT, 'config', 'config.yaml');
  if (existsSync(yamlPath)) {
    try {
      const raw = readFileSync(yamlPath, 'utf-8');
      const fileConfig = YAML.parse(raw) as Partial<AppConfig>;
      _config = mergeConfig(_config, fileConfig);
    } catch {
      // 忽略 config.yaml 解析错误
    }
  }

  return _config;
}

/**
 * 重置配置缓存（用于测试）
 */
export function resetConfig(): void {
  _config = null;
}

/**
 * 从环境变量构建配置
 *
 * 支持的 .env 变量：
 * GITHUB_TOKEN    - GitHub Token
 * SMTP_HOST       - SMTP 服务器
 * SMTP_PORT       - SMTP 端口
 * SMTP_USER       - 发件邮箱
 * SMTP_PASS       - 邮箱密码/授权码
 * SMTP_DAILY_LIMIT - 每日发送限制
 * PRODUCT_NAME    - 产品名称
 * PRODUCT_DESC    - 产品描述
 * GITHUB_REPO     - 项目 GitHub 地址
 * DRY_RUN         - 模拟模式
 */
function configFromEnv(): AppConfig {
  const sender: SenderConfig = {
    name: process.env.SMTP_USER?.split('@')[0] || '',
    email: process.env.SMTP_USER || '',
    smtp_server: process.env.SMTP_HOST || 'smtp.qq.com',
    smtp_port: parseInt(process.env.SMTP_PORT || '465', 10),
    password: process.env.SMTP_PASS || '',
    daily_limit: parseInt(process.env.SMTP_DAILY_LIMIT || '200', 10),
    status: 'active',
  };

  return {
    ...DEFAULT_CONFIG,
    senders: sender.email ? [sender] : [],
    email_content: {
      product_name: process.env.PRODUCT_NAME || DEFAULT_CONFIG.email_content.product_name,
      product_description: process.env.PRODUCT_DESC || DEFAULT_CONFIG.email_content.product_description,
      github_repo_url: process.env.GITHUB_REPO || DEFAULT_CONFIG.email_content.github_repo_url,
    },
    debug: {
      dry_run: process.env.DRY_RUN === 'true',
      log_level: process.env.LOG_LEVEL || 'info',
    },
  };
}

/**
 * 环境变量覆盖（最高优先级）
 */
function applyEnvOverrides(config: AppConfig): void {
  if (process.env.DRY_RUN === 'true') {
    config.debug.dry_run = true;
  }
  if (process.env.LOG_LEVEL) {
    config.debug.log_level = process.env.LOG_LEVEL;
  }
}

/**
 * 深度合并配置（文件配置覆盖默认配置）
 */
function mergeConfig(defaults: AppConfig, overrides: Partial<AppConfig>): AppConfig {
  const result = { ...defaults };

  if (overrides.settings) {
    result.settings = { ...defaults.settings, ...overrides.settings };
  }

  if (overrides.harvest) {
    result.harvest = { ...defaults.harvest, ...overrides.harvest };
    // topics 和 target_repos 如果提供了就完全替换
    if (overrides.harvest.topics) {
      result.harvest.topics = overrides.harvest.topics;
    }
    if (overrides.harvest.target_repos) {
      result.harvest.target_repos = overrides.harvest.target_repos;
    }
  }

  if (overrides.email_content) {
    result.email_content = { ...defaults.email_content, ...overrides.email_content };
  }

  if (overrides.debug) {
    result.debug = { ...defaults.debug, ...overrides.debug };
  }

  // senders 如果提供了就完全替换
  if (overrides.senders && overrides.senders.length > 0) {
    result.senders = overrides.senders;
  }

  return result;
}
