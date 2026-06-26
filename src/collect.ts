/**
 * GitHub 用户邮箱采集器
 *
 * 从多个维度采集目标用户邮箱：
 * - Stargazers（关注者）
 * - Issue 参与者（有明确需求的用户）
 * - PR 贡献者（活跃开发者）
 * - Fork 者（实际在用的用户）
 *
 * 合法性：只收集用户在 Git 提交中公开使用的邮箱
 */

import { Octokit } from '@octokit/rest';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '..', 'data');
const EMAILS_FILE = join(DATA_DIR, 'emails.csv');
const PROGRESS_FILE = join(DATA_DIR, 'collect_progress.json');

interface GitHubEmail {
  email: string;
  username: string;
  name: string;
  source: string;
}

interface CollectProgress {
  processedRepos: string[];
  totalEmails: number;
  timestamp: string;
}

// ============================================================
// 主入口
// ============================================================

export async function collectEmails(config: AppConfig, flags: string[] = []) {
  const resume = flags.includes('--resume');
  const statusOnly = flags.includes('--status');
  const dryRun = flags.includes('--dry-run') || config.debug.dry_run;

  // 解析 --repo 参数（支持 URL 或 owner/repo 格式）
  const manualRepo = parseRepoFlag(flags);

  const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
  });

  // 确保数据目录存在
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  // --status 模式：只显示状态
  if (statusOnly) {
    showStatus();
    return;
  }

  const allEmails: Map<string, GitHubEmail> = new Map();
  let processedUsers = 0;

  // 加载已有邮箱
  const existingEmails = loadExistingEmails();
  for (const [email, data] of existingEmails) {
    allEmails.set(email, data);
  }
  console.log(`📋 已有 ${existingEmails.size} 个邮箱`);

  // 构建目标仓库列表
  let allRepos: string[] = [];

  if (manualRepo) {
    // 手动指定仓库（优先级最高）
    allRepos = [manualRepo];
    console.log(`🔗 手动指定仓库: ${manualRepo}`);
  } else {
    // 固定仓库 + topic 搜索
    const fixedRepos = config.harvest.target_repos;
    const topicRepos = await searchReposByTopic(octokit, config, dryRun);
    allRepos = [...new Set([...fixedRepos, ...topicRepos])];
  }

  // 断点续采：跳过已处理的仓库
  let processedRepos: string[] = [];
  if (resume) {
    const progress = loadProgress();
    processedRepos = progress.processedRepos;
    if (processedRepos.length > 0) {
      console.log(`🔄 断点续采: 已跳过 ${processedRepos.length} 个仓库`);
    }
  }

  const reposToProcess = allRepos.filter(r => !processedRepos.includes(r));
  console.log(`🚀 待扫描仓库: ${reposToProcess.length} 个 (共 ${allRepos.length} 个)`);

  // 显示采集维度
  const sources = config.harvest.sources || ['stargazers'];
  console.log(`📊 采集维度: ${sources.join(', ')}\n`);

  // 检查速率限制
  await checkRateLimit(octokit);

  let currentProgress: CollectProgress = {
    processedRepos,
    totalEmails: allEmails.size,
    timestamp: new Date().toISOString(),
  };

  for (const repo of reposToProcess) {
    console.log(`📦 扫描仓库: ${repo}`);

    try {
      const [owner, repoName] = repo.split('/');
      const limit = config.harvest.per_repo_limit;

      // 根据配置的来源采集
      for (const source of sources) {
        switch (source) {
          case 'stargazers':
            await collectFromStargazers(octokit, owner, repoName, repo, limit, allEmails, config);
            break;
          case 'issues':
            await collectFromIssues(octokit, owner, repoName, repo, limit, allEmails, config);
            break;
          case 'pulls':
            await collectFromPulls(octokit, owner, repoName, repo, limit, allEmails, config);
            break;
          case 'forks':
            await collectFromForks(octokit, owner, repoName, repo, limit, allEmails, config);
            break;
        }
      }

      // 保存此仓库的进度
      currentProgress.processedRepos.push(repo);
      currentProgress.totalEmails = allEmails.size;
      currentProgress.timestamp = new Date().toISOString();
      if (!dryRun) saveProgress(currentProgress);

      console.log(`   ✅ ${repo} 完成，当前共 ${allEmails.size} 个邮箱`);
    } catch (error) {
      console.error(`   ❌ 扫描 ${repo} 失败:`, error);
    }
  }

  // 保存结果
  if (!dryRun) {
    saveEmails(Array.from(allEmails.values()));
  }
  console.log(`\n✅ 采集完成: ${allEmails.size} 个邮箱`);
}

// ============================================================
// 采集方法：Stargazers
// ============================================================

async function collectFromStargazers(
  octokit: Octokit,
  owner: string,
  repoName: string,
  repo: string,
  limit: number,
  allEmails: Map<string, GitHubEmail>,
  config: AppConfig
): Promise<void> {
  let page = 1;
  let totalFetched = 0;

  while (totalFetched < limit) {
    const perPage = Math.min(100, limit - totalFetched);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stargazers = await (octokit.repos as any).listStargazers({
      owner,
      repo: repoName,
      per_page: perPage,
      page,
    });

    if (stargazers.data.length === 0) break;
    console.log(`   ⭐ Stargazers 第 ${page} 页: ${stargazers.data.length} 人`);

    for (const user of stargazers.data) {
      const emailData = await getUserEmail(octokit, user.login, `stargazer:${repo}`);
      if (emailData) allEmails.set(emailData.email, emailData);
    }

    totalFetched += stargazers.data.length;
    page++;
    if (stargazers.data.length < perPage) break;
    await dynamicDelay(octokit, config.harvest.rate_limit_threshold);
  }
}

// ============================================================
// 采集方法：Issue 参与者
// ============================================================

async function collectFromIssues(
  octokit: Octokit,
  owner: string,
  repoName: string,
  repo: string,
  limit: number,
  allEmails: Map<string, GitHubEmail>,
  config: AppConfig
): Promise<void> {
  let page = 1;
  let totalFetched = 0;

  while (totalFetched < limit) {
    const perPage = Math.min(100, limit - totalFetched);
    const issues = await octokit.issues.listForRepo({
      owner,
      repo: repoName,
      state: 'all',
      per_page: perPage,
      page,
      sort: 'created',
      direction: 'desc',
    });

    if (issues.data.length === 0) break;
    console.log(`   📝 Issues 第 ${page} 页: ${issues.data.length} 个`);

    for (const issue of issues.data) {
      // Issue 作者
      if (issue.user?.login) {
        const emailData = await getUserEmail(octokit, issue.user.login, `issue-author:${repo}`);
        if (emailData) allEmails.set(emailData.email, emailData);
      }

      // Issue 评论者（活跃用户）
      try {
        const comments = await octokit.issues.listComments({
          owner,
          repo: repoName,
          issue_number: issue.number,
          per_page: 10,
        });
        for (const comment of comments.data) {
          if (comment.user?.login && comment.user.login !== issue.user?.login) {
            const emailData = await getUserEmail(octokit, comment.user.login, `issue-commenter:${repo}`);
            if (emailData) allEmails.set(emailData.email, emailData);
          }
        }
      } catch {
        // 忽略评论获取失败
      }
    }

    totalFetched += issues.data.length;
    page++;
    if (issues.data.length < perPage) break;
    await dynamicDelay(octokit, config.harvest.rate_limit_threshold);
  }
}

// ============================================================
// 采集方法：PR 贡献者
// ============================================================

async function collectFromPulls(
  octokit: Octokit,
  owner: string,
  repoName: string,
  repo: string,
  limit: number,
  allEmails: Map<string, GitHubEmail>,
  config: AppConfig
): Promise<void> {
  let page = 1;
  let totalFetched = 0;

  while (totalFetched < limit) {
    const perPage = Math.min(100, limit - totalFetched);
    const pulls = await octokit.pulls.list({
      owner,
      repo: repoName,
      state: 'all',
      per_page: perPage,
      page,
      sort: 'created',
      direction: 'desc',
    });

    if (pulls.data.length === 0) break;
    console.log(`   🔀 PRs 第 ${page} 页: ${pulls.data.length} 个`);

    for (const pr of pulls.data) {
      // PR 作者（高质量贡献者）
      if (pr.user?.login) {
        const emailData = await getUserEmail(octokit, pr.user.login, `pr-author:${repo}`);
        if (emailData) allEmails.set(emailData.email, emailData);
      }

      // PR 评论者/审查者
      try {
        const reviews = await octokit.pulls.listReviews({
          owner,
          repo: repoName,
          pull_number: pr.number,
        });
        for (const review of reviews.data) {
          if (review.user?.login && review.user.login !== pr.user?.login) {
            const emailData = await getUserEmail(octokit, review.user.login, `pr-reviewer:${repo}`);
            if (emailData) allEmails.set(emailData.email, emailData);
          }
        }
      } catch {
        // 忽略
      }
    }

    totalFetched += pulls.data.length;
    page++;
    if (pulls.data.length < perPage) break;
    await dynamicDelay(octokit, config.harvest.rate_limit_threshold);
  }
}

// ============================================================
// 采集方法：Fork 者
// ============================================================

async function collectFromForks(
  octokit: Octokit,
  owner: string,
  repoName: string,
  repo: string,
  limit: number,
  allEmails: Map<string, GitHubEmail>,
  config: AppConfig
): Promise<void> {
  let page = 1;
  let totalFetched = 0;

  while (totalFetched < limit) {
    const perPage = Math.min(100, limit - totalFetched);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const forks = await (octokit.repos as any).listForks({
      owner,
      repo: repoName,
      per_page: perPage,
      page,
      sort: 'newest',
    });

    if (forks.data.length === 0) break;
    console.log(`   🍴 Forks 第 ${page} 页: ${forks.data.length} 个`);

    for (const fork of forks.data) {
      if (fork.owner?.login) {
        const emailData = await getUserEmail(octokit, fork.owner.login, `forker:${repo}`);
        if (emailData) allEmails.set(emailData.email, emailData);
      }
    }

    totalFetched += forks.data.length;
    page++;
    if (forks.data.length < perPage) break;
    await dynamicDelay(octokit, config.harvest.rate_limit_threshold);
  }
}

// ============================================================
// Topic 搜索
// ============================================================

async function searchReposByTopic(
  octokit: Octokit,
  config: AppConfig,
  dryRun: boolean
): Promise<string[]> {
  const topics = config.harvest.topics;
  if (topics.length === 0) return [];

  console.log(`🔍 按 Topic 搜索仓库: ${topics.join(', ')}`);
  const foundRepos: string[] = [];

  for (const topic of topics) {
    try {
      const query = `topic:${topic} stars:>100`;
      const results = await octokit.search.repos({
        q: query,
        sort: 'stars',
        order: 'desc',
        per_page: 20,
      });

      for (const repo of results.data.items) {
        const fullName = repo.full_name;
        if (!foundRepos.includes(fullName)) {
          foundRepos.push(fullName);
        }
      }

      console.log(`   topic:${topic} → ${results.data.items.length} 个仓库`);

      if (!dryRun) {
        await new Promise(resolve => setTimeout(resolve, 2500));
      }
    } catch (error) {
      console.error(`   ❌ 搜索 topic:${topic} 失败:`, error);
    }
  }

  console.log(`   共发现 ${foundRepos.length} 个仓库\n`);
  return foundRepos;
}

// ============================================================
// 邮箱获取
// ============================================================

async function getUserEmail(
  octokit: Octokit,
  username: string,
  source: string
): Promise<GitHubEmail | null> {
  try {
    // 方法 1：通过用户公开事件获取邮箱
    const events = await octokit.activity.listPublicEventsForUser({
      username,
      per_page: 5,
    });

    for (const event of events.data) {
      const payload = event.payload as any;
      if (event.type === 'PushEvent' && payload?.commits) {
        for (const commit of payload.commits) {
          const author = commit.author;
          if (author?.email && !author.email.includes('noreply')) {
            return {
              email: author.email,
              username,
              name: username,
              source,
            };
          }
        }
      }
    }

    // 方法 2：检查用户公开邮箱
    const user = await octokit.users.getByUsername({ username });
    if (user.data.email && !user.data.email.includes('noreply')) {
      return {
        email: user.data.email,
        username,
        name: user.data.name || username,
        source,
      };
    }

    return null;
  } catch {
    return null;
  }
}

// ============================================================
// 速率限制
// ============================================================

async function dynamicDelay(octokit: Octokit, threshold: number): Promise<void> {
  try {
    const rateLimit = await octokit.rateLimit.get();
    const remaining = rateLimit.data.resources.core.remaining;

    let delay: number;
    if (remaining > 4000) {
      delay = 500;
    } else if (remaining > 2000) {
      delay = 1000;
    } else if (remaining > threshold) {
      delay = 2000;
    } else {
      delay = 3000;
      console.log(`   ⚠️ API 配额较低 (${remaining} 剩余)，放慢请求速度`);
    }

    // 随机抖动 ±30%
    const jitter = delay * (0.7 + Math.random() * 0.6);
    await new Promise(resolve => setTimeout(resolve, jitter));
  } catch {
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

async function checkRateLimit(octokit: Octokit): Promise<void> {
  try {
    const rateLimit = await octokit.rateLimit.get();
    const remaining = rateLimit.data.resources.core.remaining;
    const resetAt = new Date(rateLimit.data.resources.core.reset * 1000);

    if (remaining < 100) {
      console.log(`⚠️ GitHub API 配额不足: ${remaining} 剩余`);
      console.log(`   配额重置时间: ${resetAt.toLocaleString()}`);

      const waitMs = resetAt.getTime() - Date.now();
      if (waitMs > 0 && waitMs < 60 * 60 * 1000) {
        console.log(`   等待配额重置 (${Math.ceil(waitMs / 60000)} 分钟)...`);
        await new Promise(resolve => setTimeout(resolve, waitMs + 5000));
      }
    } else {
      console.log(`📊 GitHub API 配额: ${remaining} 剩余`);
    }
  } catch {
    // 忽略
  }
}

// ============================================================
// 数据持久化
// ============================================================

function loadExistingEmails(): Map<string, GitHubEmail> {
  const emails = new Map<string, GitHubEmail>();
  if (!existsSync(EMAILS_FILE)) return emails;

  try {
    const csv = readFileSync(EMAILS_FILE, 'utf-8');
    const lines = csv.split('\n').slice(1);
    for (const line of lines) {
      if (!line.trim()) continue;
      const [email, username, name, source] = line.split(',').map(s => s.replace(/"/g, '').trim());
      if (email) {
        emails.set(email, { email, username, name, source });
      }
    }
  } catch {
    // 忽略
  }

  return emails;
}

function saveEmails(emails: GitHubEmail[]) {
  const dir = dirname(EMAILS_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const csv = ['email,username,name,source'];
  for (const e of emails) {
    csv.push(`"${e.email}","${e.username}","${e.name}","${e.source}"`);
  }
  writeFileSync(EMAILS_FILE, csv.join('\n'));
  console.log(`💾 邮箱已保存到 ${EMAILS_FILE}`);
}

function loadProgress(): CollectProgress {
  if (!existsSync(PROGRESS_FILE)) {
    return { processedRepos: [], totalEmails: 0, timestamp: '' };
  }
  try {
    return JSON.parse(readFileSync(PROGRESS_FILE, 'utf-8'));
  } catch {
    return { processedRepos: [], totalEmails: 0, timestamp: '' };
  }
}

function saveProgress(progress: CollectProgress) {
  writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

function showStatus() {
  console.log('📊 采集状态:\n');

  if (existsSync(EMAILS_FILE)) {
    const csv = readFileSync(EMAILS_FILE, 'utf-8');
    const count = csv.split('\n').length - 1;
    console.log(`   📧 已采集邮箱: ${count} 个`);
    console.log(`   📁 文件: ${EMAILS_FILE}`);
  } else {
    console.log('   📧 尚未采集邮箱');
  }

  if (existsSync(PROGRESS_FILE)) {
    const progress = loadProgress();
    console.log(`   📦 已处理仓库: ${progress.processedRepos.length} 个`);
    console.log(`   🕐 上次更新: ${progress.timestamp}`);
  }
}

// ============================================================
// GitHub URL 解析
// ============================================================

/**
 * 解析 --repo 参数
 *
 * 支持格式：
 * - https://github.com/owner/repo
 * - github.com/owner/repo
 * - owner/repo
 *
 * 返回 owner/repo 格式，或 null（如果没有 --repo 参数）
 */
function parseRepoFlag(flags: string[]): string | null {
  const repoIdx = flags.indexOf('--repo');
  if (repoIdx === -1 || !flags[repoIdx + 1]) return null;

  const input = flags[repoIdx + 1].trim();

  // 格式 1: https://github.com/owner/repo
  const httpsMatch = input.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (httpsMatch) {
    return `${httpsMatch[1]}/${httpsMatch[2]}`;
  }

  // 格式 2: owner/repo
  const slashMatch = input.match(/^([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)$/);
  if (slashMatch) {
    return `${slashMatch[1]}/${slashMatch[2]}`;
  }

  console.error(`❌ 无法解析仓库地址: ${input}`);
  console.error('   支持格式: https://github.com/owner/repo 或 owner/repo');
  return null;
}

/**
 * 从命令行参数解析仓库列表（供外部调用）
 */
export function parseReposFromArgs(args: string[]): string[] {
  const repos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo' && args[i + 1]) {
      const repo = parseRepoFlag(['--repo', args[i + 1]]);
      if (repo) repos.push(repo);
      i++; // 跳过下一个参数
    }
  }
  return repos;
}
