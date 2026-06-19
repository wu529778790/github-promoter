/**
 * 终端交互界面（TUI）
 *
 * 用 npm run ui 启动，提供可视化的管理界面
 */

import inquirer from 'inquirer';
import { loadConfig } from './config.js';
import { collectEmails } from './collect.js';
import { ParallelSender } from './sender.js';
import { generateEmail, getCombinationCount } from './spintax.js';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '..', 'data');
const EMAILS_FILE = join(DATA_DIR, 'emails.csv');

// ============================================================
// 主菜单
// ============================================================

export async function startTUI(): Promise<void> {
  console.clear();
  console.log('╔══════════════════════════════════════════╗');
  console.log('║     🚀 GitHub Promoter 管理界面         ║');
  console.log('║     开源项目推广工具                     ║');
  console.log('╚══════════════════════════════════════════╝\n');

  let running = true;

  while (running) {
    const config = loadConfig();
    const emailCount = getEmailCount();

    console.log(`📧 当前邮箱数: ${emailCount}  |  📦 产品: ${config.email_content.product_name}\n`);

    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: '请选择操作:',
        choices: [
          { name: '📧 采集邮箱', value: 'collect' },
          { name: '👀 预览邮件', value: 'preview' },
          { name: '📤 发送邮件', value: 'send' },
          { name: '📊 查看状态', value: 'status' },
          { name: '⚙️  查看配置', value: 'config' },
          { name: '🚪 退出', value: 'exit' },
        ],
      },
    ]);

    switch (action) {
      case 'collect':
        await handleCollect(config);
        break;
      case 'preview':
        await handlePreview(config);
        break;
      case 'send':
        await handleSend(config);
        break;
      case 'status':
        await handleStatus();
        break;
      case 'config':
        await handleConfig(config);
        break;
      case 'exit':
        running = false;
        console.log('\n👋 再见！\n');
        break;
    }

    if (running) {
      console.log('\n' + '─'.repeat(40) + '\n');
    }
  }
}

// ============================================================
// 采集邮箱
// ============================================================

async function handleCollect(config: ReturnType<typeof loadConfig>): Promise<void> {
  console.log('\n📧 采集邮箱\n');

  const sources = config.harvest.sources || ['stargazers'];

  const { mode } = await inquirer.prompt([
    {
      type: 'list',
      name: 'mode',
      message: '选择采集方式:',
      choices: [
        { name: '🔗 输入仓库链接（直接采集）', value: 'manual' },
        { name: '📋 使用配置的仓库列表', value: 'config' },
        { name: '↩️ 返回', value: 'back' },
      ],
    },
  ]);

  if (mode === 'back') return;

  if (mode === 'manual') {
    // 手动输入仓库链接
    const { repoUrl } = await inquirer.prompt([
      {
        type: 'input',
        name: 'repoUrl',
        message: '输入 GitHub 仓库链接:',
        placeholder: 'https://github.com/owner/repo 或 owner/repo',
        validate: (input: string) => {
          if (!input.trim()) return '请输入仓库链接';
          // 验证格式
          const httpsMatch = input.match(/github\.com\/([^/]+)\/([^/]+)/);
          const slashMatch = input.trim().match(/^([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)$/);
          if (httpsMatch || slashMatch) return true;
          return '格式不正确，支持: https://github.com/owner/repo 或 owner/repo';
        },
      },
    ]);

    // 解析仓库地址
    let repo = repoUrl.trim();
    const httpsMatch = repo.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (httpsMatch) {
      repo = `${httpsMatch[1]}/${httpsMatch[2]}`;
    }

    const { sources: chosenSources } = await inquirer.prompt([
      {
        type: 'checkbox',
        name: 'sources',
        message: '选择采集来源:',
        choices: [
          { name: '⭐ Stargazers（关注者）', value: 'stargazers', checked: true },
          { name: '📝 Issues（参与者）', value: 'issues', checked: true },
          { name: '🔀 PRs（贡献者）', value: 'pulls', checked: true },
          { name: '🍴 Forks（Fork者）', value: 'forks', checked: true },
        ],
      },
    ]);

    console.log(`\n🔗 仓库: ${repo}`);
    console.log(`📊 来源: ${sources.join(', ')}`);

    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: '开始采集？',
        default: true,
      },
    ]);

    if (confirm) {
      console.log('');
      await collectEmails(config, ['--repo', repo]);
      console.log('\n✅ 采集完成');
    }
  } else {
    // 使用配置的仓库
    console.log(`当前采集来源: ${sources.join(', ')}`);
    console.log(`目标仓库: ${config.harvest.target_repos.length} 个`);
    console.log(`Topic: ${config.harvest.topics.join(', ')}`);

    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: '开始采集？',
        default: true,
      },
    ]);

    if (confirm) {
      console.log('');
      await collectEmails(config, []);
      console.log('\n✅ 采集完成');
    }
  }
}

// ============================================================
// 预览邮件
// ============================================================

async function handlePreview(config: ReturnType<typeof loadConfig>): Promise<void> {
  console.log('\n👀 邮件预览\n');

  const { count } = await inquirer.prompt([
    {
      type: 'number',
      name: 'count',
      message: '预览几封邮件？',
      default: 5,
    },
  ]);

  const product = config.email_content;
  const comboCount = getCombinationCount();
  const sampleNames = ['Alice', 'Bob', '张三', '李四', 'Developer', ''];

  console.log(`\n📦 产品: ${product.product_name}`);
  console.log(`🔢 组合总数: ${comboCount.toLocaleString()} 种\n`);

  for (let i = 0; i < count; i++) {
    const name = sampleNames[i % sampleNames.length];
    const email = generateEmail(name, product);

    console.log(`━━━ 第 ${i + 1} 封 (收件人: ${name || '无名'}) ━━━`);
    console.log(`主题: ${email.subject}`);
    console.log('');
    const lines = email.text.split('\n');
    for (const line of lines) {
      console.log(`  ${line}`);
    }
    console.log('');
  }

  const { action } = await inquirer.prompt([
    {
      type: 'list',
      name: 'action',
      message: '接下来:',
      choices: [
        { name: '继续预览', value: 'again' },
        { name: '返回主菜单', value: 'back' },
      ],
    },
  ]);

  if (action === 'again') {
    await handlePreview(config);
  }
}

// ============================================================
// 发送邮件
// ============================================================

async function handleSend(config: ReturnType<typeof loadConfig>): Promise<void> {
  console.log('\n📤 发送邮件\n');

  const emailCount = getEmailCount();
  const senderCount = config.senders.filter(s => s.password).length;

  console.log(`📧 待发送邮箱: ${emailCount} 个`);
  console.log(`👤 可用发件人: ${senderCount} 个`);

  if (emailCount === 0) {
    console.log('❌ 没有待发送的邮箱，请先运行采集');
    return;
  }

  if (senderCount === 0) {
    console.log('❌ 没有有效的发件人配置');
    return;
  }

  const { mode } = await inquirer.prompt([
    {
      type: 'list',
      name: 'mode',
      message: '选择发送模式:',
      choices: [
        { name: '🚀 立即发送（全部）', value: 'all' },
        { name: '📊 只查看状态', value: 'status' },
        { name: '🔌 测试 SMTP 连接', value: 'test' },
        { name: '🧪 模拟发送（不实际投递）', value: 'dryrun' },
        { name: '↩️ 返回主菜单', value: 'back' },
      ],
    },
  ]);

  switch (mode) {
    case 'all': {
      const { confirm } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: `确认发送 ${emailCount} 封邮件？`,
          default: false,
        },
      ]);
      if (confirm) {
        const sender = new ParallelSender(config);
        await sender.start();
      }
      break;
    }
    case 'status': {
      const sender = new ParallelSender(config);
      sender.showStatus();
      break;
    }
    case 'test': {
      await testConnections(config);
      break;
    }
    case 'dryrun': {
      config.debug.dry_run = true;
      const sender = new ParallelSender(config);
      await sender.start();
      break;
    }
  }
}

// ============================================================
// 查看状态
// ============================================================

async function handleStatus(): Promise<void> {
  console.log('\n📊 系统状态\n');

  // 邮箱状态
  if (existsSync(EMAILS_FILE)) {
    const csv = readFileSync(EMAILS_FILE, 'utf-8');
    const lines = csv.split('\n').slice(1).filter(l => l.trim());
    console.log(`📧 已采集邮箱: ${lines.length} 个`);

    // 统计各来源
    const sourceCount: Record<string, number> = {};
    for (const line of lines) {
      const parts = line.split(',').map(s => s.replace(/"/g, '').trim());
      const source = parts[3] || 'unknown';
      const type = source.split(':')[0];
      sourceCount[type] = (sourceCount[type] || 0) + 1;
    }

    console.log('\n   来源统计:');
    for (const [type, count] of Object.entries(sourceCount)) {
      const icon = type === 'stargazer' ? '⭐' :
                   type === 'issue-author' || type === 'issue-commenter' ? '📝' :
                   type === 'pr-author' || type === 'pr-reviewer' ? '🔀' :
                   type === 'forker' ? '🍴' : '❓';
      console.log(`   ${icon} ${type}: ${count} 个`);
    }
  } else {
    console.log('📧 尚未采集邮箱');
  }

  await inquirer.prompt([
    {
      type: 'list',
      name: 'back',
      message: '按回车返回',
      choices: [{ name: '↩️ 返回主菜单', value: 'back' }],
    },
  ]);
}

// ============================================================
// 查看配置
// ============================================================

async function handleConfig(config: ReturnType<typeof loadConfig>): Promise<void> {
  console.log('\n⚙️ 当前配置\n');

  console.log('📦 产品信息:');
  console.log(`   名称: ${config.email_content.product_name}`);
  console.log(`   描述: ${config.email_content.product_description}`);
  console.log(`   链接: ${config.email_content.github_repo_url}`);

  console.log('\n👤 发件人:');
  for (const sender of config.senders) {
    const hasPassword = sender.password ? '✅' : '❌';
    console.log(`   ${hasPassword} ${sender.name} (${sender.email}) - ${sender.smtp_server}:${sender.smtp_port}`);
  }

  console.log('\n📧 采集配置:');
  console.log(`   来源: ${(config.harvest.sources || ['stargazers']).join(', ')}`);
  console.log(`   仓库: ${config.harvest.target_repos.length} 个`);
  console.log(`   Topic: ${config.harvest.topics.join(', ')}`);
  console.log(`   每仓库限制: ${config.harvest.per_repo_limit}`);

  console.log('\n⏱️ 发送策略:');
  console.log(`   间隔: ${config.settings.email_interval_min}-${config.settings.email_interval_max} 秒`);
  console.log(`   时区: ${config.settings.timezone}`);

  console.log('\n🐛 调试:');
  console.log(`   DRY RUN: ${config.debug.dry_run}`);
  console.log(`   日志级别: ${config.debug.log_level}`);

  await inquirer.prompt([
    {
      type: 'list',
      name: 'back',
      message: '按回车返回',
      choices: [{ name: '↩️ 返回主菜单', value: 'back' }],
    },
  ]);
}

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

async function testConnections(config: ReturnType<typeof loadConfig>): Promise<void> {
  console.log('\n🔌 测试 SMTP 连接...\n');

  for (const sender of config.senders) {
    try {
      const nodemailer = await import('nodemailer');
      const transporter = nodemailer.default.createTransport({
        host: sender.smtp_server,
        port: sender.smtp_port,
        secure: sender.smtp_port === 465,
        auth: {
          user: sender.email,
          pass: sender.password,
        },
      });

      await transporter.verify();
      console.log(`✅ ${sender.name} (${sender.email}) - 连接成功`);
      await transporter.close();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`❌ ${sender.name} (${sender.email}) - 连接失败: ${msg}`);
    }
  }
}
