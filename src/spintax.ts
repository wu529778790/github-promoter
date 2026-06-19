/**
 * Spintax 随机内容生成器
 *
 * 6 层随机组合，生成独一无二的邮件内容
 * 主题 × 问候 × 开场 × 价值点 × 结尾 × 签名 = 100,000+ 种组合
 *
 * 策略：纯文本、无链接、无 HTML（避免反垃圾引擎扫描）
 *
 * 使用方法：
 *   1. 在 config/config.yaml 中配置你的产品信息
 *   2. 调用 generateEmail() 生成随机邮件内容
 *   3. 生成的内容会自动使用你配置的产品名称和描述
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================
// 配置接口
// ============================================================

interface EmailContentConfig {
  product_name: string;
  product_description: string;
  github_repo_url: string;
}

// ============================================================
// Spintax 变量库（通用版本）
// ============================================================

interface SpintaxPool {
  subjects: string[];
  greetings: string[];
  openings: string[];
  valueProps: string[];
  closings: string[];
  signatures: string[];
}

const SPINTAX: SpintaxPool = {
  // 邮件主题（10 个变体 - 通用）
  subjects: [
    '🚀 一个值得看看的开源项目',
    '💡 发现一个不错的工具，推荐给你',
    '🔧 开源项目推荐',
    '🌟 一个有趣的开源项目',
    '🎯 开发者工具推荐',
    '📱 一个提升效率的开源工具',
    '🚀 开源新项目推荐',
    '💡 开发者值得一试的工具',
    '🔧 发现一个实用的开源项目',
    '🌟 推荐一个 GitHub 上的好项目',
  ],

  // 问候语（8 个变体）
  greetings: [
    'Hi {name}',
    'Hello {name}',
    'Hey {name}',
    'Hi there {name}',
    'Hey there {name}',
    'Hi {name}, fellow dev',
    'Hello {name}',
    'Hi {name}',
  ],

  // 开场白（10 个变体 - 通用）
  openings: [
    '我在 GitHub 上看到了你的项目，印象很深。',
    '看到你在关注一些开源项目。',
    '注意到你对开源软件很感兴趣。',
    '最近在探索一些开源工具，发现了一个很有意思的项目。',
    '作为一个开发者，你可能会对这个感兴趣。',
    '在 GitHub 上看到你 star 了一些项目，推荐一个给你。',
    '看到你在用各种开发工具，这个项目你可能会喜欢。',
    '作为一个同样关注开源的人，想跟你分享一个工具。',
    '在研究开源项目时发现了这个。',
    '你的 GitHub 活动显示你对新技术很感兴趣。',
  ],

  // 价值点（10 个变体 - 通用，使用配置中的产品名）
  valueProps: [
    '{product} 是一个开源项目，{description}。完全免费，欢迎体验。',
    '{product} {description}。如果你也感兴趣，可以看看。',
    '推荐 {product}，{description}。完全开源，欢迎 Star。',
    '{product} 解决了一个痛点：{description}。值得一看。',
    '{product} 是一个值得关注的开源项目，{description}。',
    '如果你对 {description} 感兴趣，{product} 值得一试。',
    '{product}，{description}。欢迎体验和反馈。',
    '发现 {product}，{description}。完全免费开源。',
    '{product} 是一个不错的开源选择，{description}。',
    '推荐 {product}，{description}。开源项目，欢迎贡献。',
  ],

  // 结尾（8 个变体 - 通用）
  closings: [
    '如果你感兴趣，欢迎看看。有问题可以提 Issue。',
    '感兴趣的话可以看看。完全开源，欢迎 Star 和贡献。',
    '这是一个完全开源的项目，欢迎体验和反馈。',
    '如果觉得有用，欢迎给个 Star 支持一下。',
    '项目完全开源，欢迎试用和交流。',
    '如果你有好的想法，也欢迎提 PR 参与贡献。',
    '开源项目，欢迎体验。有任何建议都可以在 Issue 里提。',
    '希望对你有帮助。有问题随时交流。',
  ],

  // 签名（8 个变体 - 通用）
  signatures: [
    'Best,\n项目维护者',
    'Thanks,\n开发者',
    'Best regards,\n开源爱好者',
    'Cheers,\n一个开发者',
    '祝好,\n项目团队',
    '谢谢,\n开发者',
    '此致,\n开源社区',
    'Best,\n一个 fellow developer',
  ],
};

// ============================================================
// 工具函数
// ============================================================

/**
 * 从数组中随机选择一个元素
 */
function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * 清理收件人名称（移除特殊字符和数字）
 */
export function sanitizeName(name: string): string {
  if (!name) return 'there';
  // 移除特殊字符和数字，保留字母、空格和中文
  const cleaned = name.replace(/[^a-zA-Z\s一-鿿]/g, '').trim();
  return cleaned || 'there';
}

/**
 * 加载配置中的产品信息
 */
function loadProductConfig(): EmailContentConfig {
  // 尝试加载 config.yaml
  const configPath = join(__dirname, '..', 'config', 'config.yaml');
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf-8');
      const config = YAML.parse(raw);
      if (config?.email_content) {
        return config.email_content;
      }
    } catch {
      // 忽略
    }
  }

  // 默认值
  return {
    product_name: 'Your Project',
    product_description: '一个不错的开源项目',
    github_repo_url: 'https://github.com',
  };
}

// ============================================================
// 导出函数
// ============================================================

/**
 * 生成随机邮件主题
 */
export function generateSubject(): string {
  return pickRandom(SPINTAX.subjects);
}

/**
 * 生成随机邮件正文
 *
 * @param recipientName - 收件人名称
 * @param productConfig - 产品配置（可选，默认从 config.yaml 读取）
 */
/**
 * 退订说明（每封邮件底部自动添加）
 */
const UNSUBSCRIBE_FOOTER = '\n\n---\n如不想收到此类邮件，回复 "unsubscribe" 即可退订。';

export function generateBody(
  recipientName?: string,
  productConfig?: EmailContentConfig
): string {
  const name = sanitizeName(recipientName || '');
  const product = productConfig || loadProductConfig();

  const greeting = pickRandom(SPINTAX.greetings).replace('{name}', name || 'there');
  const opening = pickRandom(SPINTAX.openings);
  const valueProp = pickRandom(SPINTAX.valueProps)
    .replace('{product}', product.product_name)
    .replace('{description}', product.product_description);
  const closing = pickRandom(SPINTAX.closings);
  const signature = pickRandom(SPINTAX.signatures);

  return `${greeting},\n\n${opening}\n\n${valueProp}\n\n${closing}\n\n${signature}${UNSUBSCRIBE_FOOTER}`;
}

/**
 * 生成完整的随机邮件内容（主题 + 正文）
 *
 * @param recipientName - 收件人名称
 * @param productConfig - 产品配置（可选）
 */
export function generateEmail(
  recipientName?: string,
  productConfig?: EmailContentConfig
): { subject: string; text: string } {
  return {
    subject: generateSubject(),
    text: generateBody(recipientName, productConfig),
  };
}

/**
 * 获取组合总数（用于日志）
 */
export function getCombinationCount(): number {
  return (
    SPINTAX.subjects.length *
    SPINTAX.greetings.length *
    SPINTAX.openings.length *
    SPINTAX.valueProps.length *
    SPINTAX.closings.length *
    SPINTAX.signatures.length
  );
}
