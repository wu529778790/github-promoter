# GitHub Promoter

GitHub 开源项目推广工具 — 从 GitHub 采集目标用户邮箱，自动发送个性化推广邮件。

适用于所有开源项目的推广：你的工具、库、框架、插件等等。从相关仓库的 stargazer 中找到你的目标用户，用随机生成的个性化邮件推广你的项目。

## 功能

- **多维度邮箱采集**：Stargazers / Issue 参与者 / PR 贡献者 / Fork 者
- **多发件人并行**：支持多个 SMTP 账号同时发送，提高效率
- **Spintax 随机内容**：51 万+ 种邮件组合，避免被识别为垃圾邮件
- **反垃圾**：随机延迟（3-7 分钟），模拟人类行为
- **邮件预览**：发送前先预览邮件内容，确认无误再发
- **按产品去重**：同一邮箱推广不同产品可重复发送，同一产品不重复
- **退订机制**：每封邮件自动包含退订说明，符合 CAN-SPAM/GDPR
- **进度持久化**：支持中断恢复，避免重复发送
- **速率限制感知**：自动检测 GitHub API 配额，动态调整请求速度
- **断点续采**：采集过程中断后可从上次位置继续
- **Topic 搜索**：按 GitHub Topic 自动发现目标仓库

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置（二选一）
# 方式 A：配置文件（推荐）
cp config/config.yaml.example config/config.yaml
# 编辑 config/config.yaml 填写你的配置

# 方式 B：环境变量
export GITHUB_TOKEN="your_github_token"
export SMTP_USER="your_email@qq.com"
export SMTP_PASS="your_smtp_password"

# 3. 采集邮箱
npm run collect

# 4. 发送邮件
npm run send
```

## 配置说明

### 配置文件（推荐）

复制 `config/config.yaml.example` 为 `config/config.yaml`，然后修改：

```yaml
# 多发件人配置
senders:
  - name: "Your Name"
    email: "your_email@qq.com"
    smtp_server: "smtp.qq.com"
    smtp_port: 465
    password: "YOUR_APP_PASSWORD"
    daily_limit: 200

# 采集配置 - 根据你的项目填写相关 topic 和仓库
harvest:
  topics:
    - "ai-tool"           # 与你项目相关的 topic
    - "react"             # 例如你是 React 库就填 react
    - "vue"               # 例如你是 Vue 库就填 vue
  target_repos:
    - "facebook/react"    # 相关仓库的 stargazer 是你的目标用户
    - "vuejs/core"

# 推广内容 - 必填！
email_content:
  product_name: "My Awesome Project"
  product_description: "一个让 React 开发更简单的工具"
  github_repo_url: "https://github.com/your-username/your-project"
```

### 邮件模板生成

Spintax 引擎会自动将你的产品信息填入邮件模板，生成 10 万+ 种不同组合：

- **主题**：10 种变化
- **问候**：8 种变化
- **开场白**：10 种变化
- **产品介绍**：10 种变化（自动使用你的 product_name 和 description）
- **结尾**：8 种变化
- **签名**：8 种变化

### 环境变量

| 变量 | 说明 | 必需 |
|------|------|------|
| `GITHUB_TOKEN` | GitHub Personal Access Token | ✅ |
| `SMTP_USER` | 发件邮箱 | ✅ |
| `SMTP_PASS` | 邮箱密码或授权码 | ✅ |
| `SMTP_HOST` | SMTP 服务器（默认 smtp.qq.com） | ❌ |
| `SMTP_PORT` | SMTP 端口（默认 465） | ❌ |
| `DRY_RUN` | 模拟运行（true/false） | ❌ |

## CLI 命令

```bash
# 采集
npm run collect                    # 默认采集
npm run collect -- --resume        # 断点续采
npm run collect -- --status        # 查看采集进度
npm run collect -- --dry-run       # 模拟采集

# 预览
npm run preview                    # 预览 5 封随机邮件
npm run preview -- --count 10      # 预览 10 封

# 发送
npm run send                       # 默认发送
npm run send -- --count 50         # 限制发送数量
npm run send -- --dry-run          # 模拟发送
npm run send -- --status           # 查看发送状态
npm run send -- --test-connection  # 测试 SMTP 连接

# 测试
npm test                           # 运行所有测试
npm run test:watch                 # 监听模式
```

## 架构

```
[GitHub Repos] → [Collector] → [emails.csv] → [Sender] → [SMTP Servers]
                        ↓                              ↓
              [Topic 搜索 + 分页]            [多发件人并行 + Spintax]
              [速率限制感知]                  [进度持久化 + 重试]
              [断点续采]                      [优雅退出]
```

## 文件结构

```
github-promoter/
├── src/
│   ├── index.ts          # 主入口 CLI
│   ├── config.ts         # 配置加载器
│   ├── collect.ts        # 邮箱采集
│   ├── sender.ts         # 多发件人并行发送
│   ├── progress.ts       # 进度管理器
│   └── spintax.ts        # 随机内容生成
├── config/
│   └── config.yaml.example  # 配置模板
├── tests/
│   ├── config.test.ts
│   ├── spintax.test.ts
│   └── progress.test.ts
├── data/                 # 运行时数据（自动生成）
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── README.md
```

## 使用场景

### 推广你的开源库
```yaml
harvest:
  topics: ["react", "typescript", "frontend"]
  target_repos: ["facebook/react", "microsoft/typescript"]
email_content:
  product_name: "My React Component Library"
  product_description: "一套高质量的 React UI 组件"
```

### 推广你的开发工具
```yaml
harvest:
  topics: ["cli", "developer-tools", "productivity"]
  target_repos: ["vercel/next.js", "nuxt/nuxt"]
email_content:
  product_name: "DevTool Pro"
  product_description: "提升开发效率的命令行工具"
```

### 推广你的 AI 项目
```yaml
harvest:
  topics: ["ai", "llm", "machine-learning"]
  target_repos: ["openai/openai-python", "anthropics/anthropic-sdk-python"]
email_content:
  product_name: "AI Code Assistant"
  product_description: "基于 LLM 的智能代码补全工具"
```

## 合法性

- 只采集**公开邮箱**（Git commit 中的）
- 邮件内容与开源项目相关
- 遵守 CAN-SPAM、GDPR 等法规
- 邮件中包含退订说明

## License

MIT
