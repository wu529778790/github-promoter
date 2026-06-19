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
    target_repos: [
      'anthropics/claude-code',
      'lobehub/lobe-chat',
      'labring/FastGPT',
    ],
    per_repo_limit: 100,
    rate_limit_threshold: 100,
    sources: ['stargazers', 'issues', 'pulls', 'forks'],
  },
  email_content: {
    product_name: 'Your Project',
    product_description: '一个不错的开源项目',
    github_repo_url: 'https://github.com/wu529778790/open-im',
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
 * 加载配置文件（带缓存）
 */
export function loadConfig(configPath?: string): AppConfig {
  if (_config) return _config;

  const yamlPath = configPath || join(PROJECT_ROOT, 'config', 'config.yaml');

  if (existsSync(yamlPath)) {
    try {
      const raw = readFileSync(yamlPath, 'utf-8');
      const fileConfig = YAML.parse(raw) as Partial<AppConfig>;
      _config = mergeConfig(DEFAULT_CONFIG, fileConfig);
      console.log(`📋 已加载配置: ${yamlPath}`);
    } catch (error) {
      console.warn(`⚠️ 配置文件解析失败，使用默认配置:`, error);
      _config = { ...DEFAULT_CONFIG };
    }
  } else {
    // 回退到环境变量模式
    _config = configFromEnv();
    console.log('📋 未找到 config.yaml，使用环境变量配置');
  }

  // 环境变量覆盖（优先级最高）
  applyEnvOverrides(_config);

  return _config;
}

/**
 * 重置配置缓存（用于测试）
 */
export function resetConfig(): void {
  _config = null;
}

/**
 * 从环境变量构建配置（向后兼容）
 */
function configFromEnv(): AppConfig {
  return {
    ...DEFAULT_CONFIG,
    senders: [
      {
        name: process.env.SMTP_USER || '',
        email: process.env.SMTP_USER || '',
        smtp_server: process.env.SMTP_HOST || 'smtp.qq.com',
        smtp_port: parseInt(process.env.SMTP_PORT || '465', 10),
        password: process.env.SMTP_PASS || '',
        daily_limit: parseInt(process.env.SMTP_DAILY_LIMIT || '200', 10),
      },
    ],
  };
}

/**
 * 环境变量覆盖（最高优先级）
 */
function applyEnvOverrides(config: AppConfig): void {
  // SMTP 覆盖（兼容单发件人模式）
  if (process.env.SMTP_HOST && config.senders.length <= 1) {
    if (config.senders.length === 0) {
      config.senders.push({
        name: '',
        email: '',
        smtp_server: '',
        smtp_port: 465,
        password: '',
        daily_limit: 200,
      });
    }
    config.senders[0].smtp_server = process.env.SMTP_HOST;
  }

  if (process.env.SMTP_PORT && config.senders.length >= 1) {
    config.senders[0].smtp_port = parseInt(process.env.SMTP_PORT, 10);
  }

  if (process.env.SMTP_USER && config.senders.length >= 1) {
    config.senders[0].email = process.env.SMTP_USER;
    config.senders[0].name = config.senders[0].name || process.env.SMTP_USER;
  }

  if (process.env.SMTP_PASS && config.senders.length >= 1) {
    config.senders[0].password = process.env.SMTP_PASS;
  }

  // 调试模式覆盖
  if (process.env.DRY_RUN === 'true') {
    config.debug.dry_run = true;
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
