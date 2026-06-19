/**
 * GitHub Promoter - 主入口
 *
 * 用法：
 *   npm run collect                    采集邮箱
 *   npm run collect -- --resume        断点续采
 *   npm run collect -- --status        查看采集进度
 *   npm run collect -- --dry-run       模拟采集
 *
 *   npm run preview                    预览邮件内容
 *   npm run preview -- --count 20      预览 20 封
 *
 *   npm run send                       发送推广邮件
 *   npm run send -- --count 50         限制数量
 *   npm run send -- --dry-run          模拟发送
 *   npm run send -- --status           查看发送状态
 *   npm run send -- --test-connection  测试 SMTP 连接
 */

import { loadConfig } from './config.js';
import { collectEmails } from './collect.js';
import { ParallelSender } from './sender.js';
import { generateEmail, getCombinationCount } from './spintax.js';

const args = process.argv.slice(2);
const command = args[0];
const flags = args.slice(1);

async function main() {
  const config = loadConfig();

  switch (command) {
    case 'collect':
      await collectEmails(config, flags);
      break;

    case 'preview':
      showPreview(config, flags);
      break;

    case 'send':
      if (config.senders.length === 0) {
        console.error('❌ 没有配置发件人。请在 config/config.yaml 中配置 senders，或设置 SMTP_USER/SMTP_PASS 环境变量');
        process.exit(1);
      }

      if (flags.includes('--status')) {
        const sender = new ParallelSender(config);
        sender.showStatus();
        break;
      }

      if (flags.includes('--test-connection')) {
        await testConnections(config);
        break;
      }

      // 解析 --count 参数
      let limit: number | undefined;
      const countIdx = flags.indexOf('--count');
      if (countIdx !== -1 && flags[countIdx + 1]) {
        limit = parseInt(flags[countIdx + 1], 10);
      }

      const sender = new ParallelSender(config);
      await sender.start(limit);
      break;

    default:
      // 没有命令时，启动 Web 管理界面
      console.log('\n🚀 启动 Web 管理界面...\n');
      const { startServer } = await import('./server.js');
      startServer();
  }
}

// ============================================================
// 邮件预览
// ============================================================

function showPreview(config: ReturnType<typeof loadConfig>, flags: string[]): void {
  // 解析 --count 参数
  let count = 5;
  const countIdx = flags.indexOf('--count');
  if (countIdx !== -1 && flags[countIdx + 1]) {
    count = parseInt(flags[countIdx + 1], 10);
  }

  const product = config.email_content;
  const comboCount = getCombinationCount();

  console.log('📧 邮件预览\n');
  console.log(`📦 产品: ${product.product_name}`);
  console.log(`📝 描述: ${product.product_description}`);
  console.log(`🔢 组合总数: ${comboCount.toLocaleString()} 种`);
  console.log(`👀 预览数量: ${count} 封\n`);

  console.log('─'.repeat(60));

  const sampleNames = ['Alice', 'Bob', '张三', '李四', 'Developer', ''];
  for (let i = 0; i < count; i++) {
    const name = sampleNames[i % sampleNames.length];
    const email = generateEmail(name, product);

    console.log(`\n📧 第 ${i + 1} 封 (收件人: ${name || '无名'})`);
    console.log(`   主题: ${email.subject}`);
    console.log('   ' + '─'.repeat(50));
    // 缩进正文
    const lines = email.text.split('\n');
    for (const line of lines) {
      console.log(`   ${line}`);
    }
    console.log('─'.repeat(60));
  }

  console.log(`\n💡 确认内容无误后，运行 npm run send 开始发送`);
  console.log(`💡 如需修改邮件内容，编辑 config/config.yaml 中的 email_content`);
}

// ============================================================
// SMTP 连接测试
// ============================================================

async function testConnections(config: ReturnType<typeof loadConfig>): Promise<void> {
  console.log('🔌 测试 SMTP 连接...\n');

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

// ============================================================
// 帮助信息
// ============================================================

function printHelp(): void {
  console.log(`
GitHub Promoter - 开源项目推广工具

用法:
  npm run collect                    采集 GitHub 用户邮箱
  npm run collect -- --resume        断点续采
  npm run collect -- --status        查看采集进度
  npm run collect -- --dry-run       模拟采集
  npm run collect -- --repo owner/repo   直接采集指定仓库

  npm run ui                         启动交互式管理界面
  npm run preview                    预览邮件内容
  npm run preview -- --count 10      预览 10 封

  npm run send                       发送推广邮件
  npm run send -- --count 50         限制发送数量
  npm run send -- --dry-run          模拟发送
  npm run send -- --status           查看发送状态
  npm run send -- --test-connection  测试 SMTP 连接

配置方式（二选一）:
  1. 配置文件: cp config/config.yaml.example config/config.yaml
  2. 环境变量: export GITHUB_TOKEN / SMTP_USER / SMTP_PASS

更多配置选项请参考 config/config.yaml.example
  `);
}

main().catch(console.error);
