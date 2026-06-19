/**
 * GitHub Promoter - 前端逻辑
 */

// ============================================================
// 页面导航
// ============================================================

document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    const page = item.dataset.page;
    switchPage(page);
  });
});

function switchPage(page) {
  // 更新导航
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelector(`[data-page="${page}"]`)?.classList.add('active');

  // 更新页面
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(`page-${page}`)?.classList.add('active');

  // 加载页面数据
  switch (page) {
    case 'dashboard': loadDashboard(); break;
    case 'config': loadConfigPage(); break;
    case 'logs': loadLogs(); break;
    case 'send': loadSendStatus(); break;
  }
}

// ============================================================
// Toast 通知
// ============================================================

function showToast(msg, type = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = `toast show ${type}`;
  setTimeout(() => { toast.className = 'toast'; }, 3000);
}

// ============================================================
// 状态消息
// ============================================================

function showStatus(elementId, msg, type = 'info') {
  const el = document.getElementById(elementId);
  if (el) {
    el.textContent = msg;
    el.className = `status-msg show ${type}`;
  }
}

// ============================================================
// API 请求
// ============================================================

async function api(url, options = {}) {
  try {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    return await res.json();
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// ============================================================
// 仪表盘
// ============================================================

async function loadDashboard() {
  const result = await api('/api/status');
  if (!result.ok) return;

  const d = result.data;

  // 统计数字
  document.getElementById('email-count').textContent = d.emailCount;
  document.getElementById('sender-count').textContent = d.senders.length;
  document.getElementById('combo-count').textContent = d.combinationCount?.toLocaleString() || '-';
  document.getElementById('product-name').textContent = d.product?.product_name || '-';

  // 来源统计
  const sourceEl = document.getElementById('source-stats');
  const stats = d.productStats;
  if (Object.keys(stats).length === 0) {
    sourceEl.innerHTML = '<span style="color: var(--text-muted)">暂无数据</span>';
  } else {
    const icons = { stargazer: '⭐', 'issue-author': '📝', 'issue-commenter': '💬', 'pr-author': '🔀', 'pr-reviewer': '🔍', forker: '🍴' };
    sourceEl.innerHTML = Object.entries(stats).map(([type, count]) =>
      `<div class="source-item"><span>${icons[type] || '❓'}</span><span>${type}</span><span class="source-count">${count}</span></div>`
    ).join('');
  }

  // 发件人列表
  const senderEl = document.getElementById('sender-list');
  senderEl.innerHTML = d.senders.map(s =>
    `<div class="sender-item">
      <div class="sender-info">
        <span>👤</span>
        <span>${s.name || s.email}</span>
        <span style="color: var(--text-muted); font-size: 12px">${s.server}:${s.email}</span>
      </div>
      <span class="sender-status ${s.status}">${s.status === 'active' ? '🟢 活跃' : '⏸️ 禁用'}</span>
    </div>`
  ).join('');
}

// ============================================================
// 快速操作
// ============================================================

async function quickCollect() {
  if (!confirm('确认开始采集邮箱？')) return;
  showToast('采集已启动...');
  const result = await api('/api/collect', { method: 'POST', body: '{}' });
  showToast(result.ok ? '采集完成' : `采集失败: ${result.error}`, result.ok ? 'success' : 'error');
}

async function quickSend() {
  if (!confirm('确认开始发送邮件？')) return;
  showToast('发送已启动...');
  const result = await api('/api/send', {
    method: 'POST',
    body: JSON.stringify({ dryRun: false }),
  });
  showToast(result.ok ? result.message : `发送失败: ${result.error}`, result.ok ? 'success' : 'error');
}

async function testSmtp() {
  showToast('正在测试连接...');
  const result = await api('/api/test-smtp', { method: 'POST' });
  if (result.ok) {
    const allOk = result.data.every(r => r.success);
    const msgs = result.data.map(r => `${r.name}: ${r.success ? '✅' : '❌ ' + r.message}`).join('\n');
    showToast(allOk ? '所有连接成功' : '部分连接失败', allOk ? 'success' : 'error');
    alert(msgs);
  } else {
    showToast(`测试失败: ${result.error}`, 'error');
  }
}

// ============================================================
// 采集
// ============================================================

async function startCollect() {
  const repo = document.getElementById('collect-repo').value.trim();
  if (!repo) {
    showStatus('collect-status', '请输入仓库链接', 'error');
    return;
  }

  showStatus('collect-status', '采集中...', 'info');
  const result = await api('/api/collect', {
    method: 'POST',
    body: JSON.stringify({ repo }),
  });
  showStatus('collect-status', result.ok ? '✅ 采集完成' : `❌ ${result.error}`, result.ok ? 'success' : 'error');
}

async function startCollectConfig() {
  showStatus('collect-status', '采集中...', 'info');
  const result = await api('/api/collect', { method: 'POST', body: '{}' });
  showStatus('collect-status', result.ok ? '✅ 采集完成' : `❌ ${result.error}`, result.ok ? 'success' : 'error');
}

// ============================================================
// 预览
// ============================================================

async function loadPreview() {
  const count = document.getElementById('preview-count').value || 5;
  const result = await api(`/api/preview?count=${count}`);
  if (!result.ok) return;

  const list = document.getElementById('preview-list');
  list.innerHTML = result.data.map(e =>
    `<div class="preview-item">
      <div class="preview-header">
        <span>第 ${e.index} 封</span>
        <span>收件人: ${e.recipient}</span>
      </div>
      <div class="preview-subject">📧 ${e.subject}</div>
      <div class="preview-body">${e.text}</div>
    </div>`
  ).join('');
}

// ============================================================
// 发送
// ============================================================

async function startSend() {
  const limit = parseInt(document.getElementById('send-limit').value) || 0;
  const dryRun = document.getElementById('send-dryrun').checked;

  if (!dryRun && !confirm('确认开始发送邮件？')) return;

  showStatus('send-status', dryRun ? '模拟发送中...' : '发送中...', 'info');
  const result = await api('/api/send', {
    method: 'POST',
    body: JSON.stringify({ dryRun, limit: limit || undefined }),
  });
  showStatus('send-status', result.ok ? `✅ ${result.message}` : `❌ ${result.error}`, result.ok ? 'success' : 'error');
}

async function loadSendStatus() {
  const result = await api('/api/send-status');
  if (!result.ok) return;

  const d = result.data;
  const el = document.getElementById('send-progress');
  el.innerHTML = `
    <div style="display: flex; gap: 20px; flex-wrap: wrap;">
      <div>📊 采集邮箱: <strong>${d.emailCount}</strong></div>
      <div>🔄 采集中: <strong>${d.isCollecting ? '是' : '否'}</strong></div>
      <div>📤 发送中: <strong>${d.isSending ? '是' : '否'}</strong></div>
    </div>
    ${Object.keys(d.productStats).length > 0 ? `
      <div style="margin-top: 12px; color: var(--text-muted);">各来源统计:</div>
      <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px;">
        ${Object.entries(d.productStats).map(([k, v]) => `<span class="source-item">${k}: ${v}</span>`).join('')}
      </div>
    ` : ''}
  `;
}

// ============================================================
// 配置管理
// ============================================================

async function loadConfigPage() {
  const result = await api('/api/config');
  const editor = document.getElementById('config-editor');
  if (result.ok && result.data) {
    editor.value = result.data; // 已经是 YAML 字符串
  } else if (result.ok) {
    editor.value = '# 未找到 config.yaml\n# 请先复制 config/config.yaml.example\n';
  } else {
    editor.value = `# 错误: ${result.error}`;
  }
}

async function saveConfig() {
  const content = document.getElementById('config-editor').value;
  try {
    // 简单验证 YAML 格式
    const config = parseSimpleYaml(content);
    const result = await api('/api/config', {
      method: 'POST',
      body: JSON.stringify(config),
    });
    showStatus('config-status', result.ok ? '✅ 配置已保存' : `❌ ${result.error}`, result.ok ? 'success' : 'error');
  } catch (e) {
    showStatus('config-status', `❌ YAML 格式错误: ${e.message}`, 'error');
  }
}

// 简单的 YAML 解析（用于验证）
function parseSimpleYaml(text) {
  // 这里只是简单检查，实际保存由后端 YAML 库处理
  if (!text.trim()) throw new Error('配置为空');
  return text; // 直接传给后端解析
}

// ============================================================
// 日志
// ============================================================

let logTimer = null;

async function loadLogs() {
  const result = await api('/api/logs');
  const el = document.getElementById('log-content');
  if (!result.ok) {
    el.textContent = `错误: ${result.error}`;
    return;
  }

  if (result.data.length === 0) {
    el.innerHTML = '<span style="color: var(--text-muted)">暂无日志</span>';
    return;
  }

  el.innerHTML = result.data.map(line => {
    let cls = '';
    if (line.includes('ERROR')) cls = 'error';
    else if (line.includes('WARN')) cls = 'warn';
    return `<div class="log-line ${cls}">${escapeHtml(line)}</div>`;
  }).join('');

  // 滚动到底部
  el.scrollTop = el.scrollHeight;
}

function toggleLogAutoRefresh() {
  const checked = document.getElementById('log-autorefresh').checked;
  if (checked) {
    logTimer = setInterval(loadLogs, 5000);
  } else {
    clearInterval(logTimer);
    logTimer = null;
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ============================================================
// 主题切换
// ============================================================

function initTheme() {
  // 1. 优先使用 localStorage 中保存的偏好
  const saved = localStorage.getItem('theme');
  if (saved) {
    applyTheme(saved);
    return;
  }

  // 2. 跟随系统偏好
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
  applyTheme(prefersDark.matches ? 'dark' : 'light');

  // 监听系统主题变化
  prefersDark.addEventListener('change', (e) => {
    if (!localStorage.getItem('theme')) {
      applyTheme(e.matches ? 'dark' : 'light');
    }
  });
}

function toggleTheme() {
  const current = document.documentElement.classList.contains('light') ? 'light' : 'dark';
  const next = current === 'light' ? 'dark' : 'light';
  localStorage.setItem('theme', next);
  applyTheme(next);
}

function applyTheme(theme) {
  const root = document.documentElement;
  const btn = document.getElementById('theme-toggle');

  if (theme === 'light') {
    root.classList.add('light');
    if (btn) btn.textContent = '☀️';
  } else {
    root.classList.remove('light');
    if (btn) btn.textContent = '🌙';
  }
}

// ============================================================
// 初始化
// ============================================================

initTheme();
loadDashboard();
