/**
 * Admin UI - 内嵌 HTML/CSS/JS 模板
 */

export function getLoginPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>droid2api 管理后台 - 登录</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif;
      background: #0f1117;
      color: #e4e4e7;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .login-card {
      background: #1a1b23;
      border: 1px solid #2a2b35;
      border-radius: 12px;
      padding: 40px;
      width: 100%;
      max-width: 400px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.4);
    }
    .login-card h1 {
      font-size: 24px;
      margin-bottom: 8px;
      color: #fff;
      text-align: center;
    }
    .login-card .subtitle {
      color: #71717a;
      font-size: 14px;
      text-align: center;
      margin-bottom: 32px;
    }
    .form-group {
      margin-bottom: 20px;
    }
    .form-group label {
      display: block;
      font-size: 14px;
      color: #a1a1aa;
      margin-bottom: 6px;
    }
    .form-group input {
      width: 100%;
      padding: 10px 14px;
      background: #0f1117;
      border: 1px solid #2a2b35;
      border-radius: 8px;
      color: #e4e4e7;
      font-size: 15px;
      outline: none;
      transition: border-color 0.2s;
    }
    .form-group input:focus {
      border-color: #6366f1;
    }
    .btn-login {
      width: 100%;
      padding: 12px;
      background: #6366f1;
      border: none;
      border-radius: 8px;
      color: #fff;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    .btn-login:hover { background: #4f46e5; }
    .btn-login:disabled { opacity: 0.6; cursor: not-allowed; }
    .error-msg {
      color: #ef4444;
      font-size: 13px;
      margin-top: 12px;
      text-align: center;
      display: none;
    }
  </style>
</head>
<body>
  <div class="login-card">
    <h1>droid2api</h1>
    <div class="subtitle">管理控制台</div>
    <form id="loginForm">
      <div class="form-group">
        <label for="username">用户名</label>
        <input type="text" id="username" name="username" autocomplete="username" placeholder="请输入用户名" required>
      </div>
      <div class="form-group">
        <label for="password">密码</label>
        <input type="password" id="password" name="password" autocomplete="current-password" placeholder="请输入密码" required>
      </div>
      <button type="submit" class="btn-login" id="loginBtn">登 录</button>
      <div class="error-msg" id="errorMsg"></div>
    </form>
  </div>
  <script>
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('loginBtn');
      const errEl = document.getElementById('errorMsg');
      btn.disabled = true;
      errEl.style.display = 'none';
      try {
        const res = await fetch('/admin/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: document.getElementById('username').value,
            password: document.getElementById('password').value
          })
        });
        const data = await res.json();
        if (res.ok) {
          window.location.href = '/admin/dashboard';
        } else {
          errEl.textContent = data.message || '登录失败';
          errEl.style.display = 'block';
        }
      } catch (err) {
        errEl.textContent = '网络错误，请稍后重试';
        errEl.style.display = 'block';
      } finally {
        btn.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

export function getDashboardPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>droid2api 管理后台</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif;
      background: #0f1117;
      color: #e4e4e7;
      min-height: 100vh;
    }

    /* Top Bar */
    .topbar {
      background: #1a1b23;
      border-bottom: 1px solid #2a2b35;
      padding: 0 24px;
      height: 56px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .topbar h1 { font-size: 18px; color: #fff; }
    .topbar .actions { display: flex; gap: 12px; align-items: center; }
    .btn {
      padding: 8px 16px;
      border: none;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn-primary { background: #6366f1; color: #fff; }
    .btn-primary:hover { background: #4f46e5; }
    .btn-secondary { background: #27272a; color: #e4e4e7; border: 1px solid #3f3f46; }
    .btn-secondary:hover { background: #3f3f46; }
    .btn-danger { background: #dc2626; color: #fff; }
    .btn-danger:hover { background: #b91c1c; }
    .btn-sm { padding: 5px 10px; font-size: 12px; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }

    /* Main Content */
    .container { max-width: 1200px; margin: 0 auto; padding: 24px; }

    /* Stats Cards */
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .stat-card {
      background: #1a1b23;
      border: 1px solid #2a2b35;
      border-radius: 10px;
      padding: 20px;
    }
    .stat-card .label { font-size: 13px; color: #71717a; margin-bottom: 4px; }
    .stat-card .value { font-size: 28px; font-weight: 700; color: #fff; }
    .stat-card .value.green { color: #22c55e; }
    .stat-card .value.red { color: #ef4444; }
    .stat-card .value.yellow { color: #eab308; }

    /* Toolbar */
    .toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
      flex-wrap: wrap;
      gap: 8px;
    }
    .toolbar .left { display: flex; gap: 8px; flex-wrap: wrap; }

    /* Table */
    .table-wrap {
      background: #1a1b23;
      border: 1px solid #2a2b35;
      border-radius: 10px;
      overflow: hidden;
    }
    table { width: 100%; border-collapse: collapse; }
    th {
      text-align: left;
      padding: 12px 16px;
      font-size: 12px;
      color: #71717a;
      border-bottom: 1px solid #2a2b35;
      font-weight: 600;
    }
    td {
      padding: 12px 16px;
      font-size: 14px;
      border-bottom: 1px solid #1f2028;
      vertical-align: middle;
    }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #1f2028; }

    /* Status badges */
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 500;
    }
    .badge-active { background: rgba(34,197,94,0.15); color: #22c55e; }
    .badge-error { background: rgba(239,68,68,0.15); color: #ef4444; }
    .badge-forbidden { background: rgba(244,63,94,0.18); color: #fb7185; }
    .badge-exhausted { background: rgba(249,115,22,0.15); color: #f97316; }
    .badge-checking { background: rgba(99,102,241,0.15); color: #818cf8; }
    .badge-cooldown { background: rgba(234,179,8,0.15); color: #eab308; font-size: 11px; }
    .badge-disabled { background: rgba(113,113,122,0.15); color: #71717a; }

    /* Progress bar */
    .progress-bar {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .progress-track {
      width: 80px;
      height: 6px;
      background: #27272a;
      border-radius: 3px;
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      border-radius: 3px;
      transition: width 0.3s;
    }
    .progress-fill.low { background: #22c55e; }
    .progress-fill.mid { background: #eab308; }
    .progress-fill.high { background: #ef4444; }
    .progress-text { font-size: 13px; color: #a1a1aa; min-width: 45px; }

    /* Cell actions */
    .cell-actions { display: flex; gap: 4px; flex-wrap: wrap; }

    /* Modal */
    .modal-overlay {
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.6);
      display: flex; align-items: center; justify-content: center;
      z-index: 1000;
    }
    .modal-overlay.hidden { display: none; }
    .modal {
      background: #1a1b23;
      border: 1px solid #2a2b35;
      border-radius: 12px;
      padding: 28px;
      width: 100%; max-width: 520px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    }
    .modal h2 { margin-bottom: 16px; font-size: 18px; color: #fff; }
    .modal .form-group { margin-bottom: 16px; }
    .modal label { display: block; font-size: 13px; color: #a1a1aa; margin-bottom: 4px; }
    .modal input, .modal textarea {
      width: 100%;
      padding: 10px 12px;
      background: #0f1117;
      border: 1px solid #2a2b35;
      border-radius: 8px;
      color: #e4e4e7;
      font-size: 14px;
      outline: none;
      font-family: inherit;
    }
    .modal textarea { min-height: 160px; resize: vertical; font-family: 'SF Mono', Monaco, monospace; font-size: 12px; }
    .modal input:focus, .modal textarea:focus { border-color: #6366f1; }
    .modal .modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }

    /* Modal Tabs */
    .modal-tabs {
      display: flex;
      gap: 0;
      margin-bottom: 20px;
      border-bottom: 1px solid #2a2b35;
    }
    .modal-tab {
      padding: 8px 20px;
      font-size: 14px;
      color: #71717a;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: all 0.2s;
      background: none;
      border-top: none;
      border-left: none;
      border-right: none;
    }
    .modal-tab:hover { color: #a1a1aa; }
    .modal-tab.active { color: #6366f1; border-bottom-color: #6366f1; }
    .tab-pane { display: none; }
    .tab-pane.active { display: block; }

    /* File upload */
    .file-upload-area {
      border: 2px dashed #2a2b35;
      border-radius: 8px;
      padding: 20px;
      text-align: center;
      cursor: pointer;
      transition: all 0.2s;
      margin-bottom: 8px;
      position: relative;
    }
    .file-upload-area:hover { border-color: #6366f1; background: rgba(99,102,241,0.05); }
    .file-upload-area.has-file { border-color: #22c55e; background: rgba(34,197,94,0.05); }
    .file-upload-area input[type=file] {
      position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%;
    }
    .file-upload-area .hint { color: #71717a; font-size: 13px; }
    .file-upload-area .filename { color: #22c55e; font-size: 13px; font-weight: 500; }
    .input-divider {
      display: flex; align-items: center; gap: 12px; margin: 10px 0; color: #71717a; font-size: 12px;
    }
    .input-divider::before, .input-divider::after {
      content: ''; flex: 1; height: 1px; background: #2a2b35;
    }

    /* Toast */
    .toast {
      position: fixed; top: 20px; right: 20px;
      padding: 12px 20px;
      border-radius: 8px;
      font-size: 14px;
      z-index: 2000;
      opacity: 0;
      transform: translateY(-10px);
      transition: all 0.3s;
    }
    .toast.show { opacity: 1; transform: translateY(0); }
    .toast.success { background: #166534; color: #bbf7d0; }
    .toast.error { background: #991b1b; color: #fecaca; }

    .empty-state {
      text-align: center;
      padding: 48px 24px;
      color: #71717a;
    }
    .empty-state p { margin-bottom: 16px; }

    .text-muted { color: #71717a; font-size: 12px; }
    .text-ellipsis { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  </style>
</head>
<body>
  <!-- Top Bar -->
  <div class="topbar">
    <h1>droid2api 管理后台</h1>
    <div class="actions">
      <span class="text-muted" id="autoRefreshLabel">自动刷新: 60秒</span>
      <button class="btn btn-secondary btn-sm" onclick="logout()">退出登录</button>
    </div>
  </div>

  <div class="container">
    <!-- Stats -->
    <div class="stats">
      <div class="stat-card"><div class="label">总账号数</div><div class="value" id="statTotal">-</div></div>
      <div class="stat-card"><div class="label">活跃</div><div class="value green" id="statActive">-</div></div>
      <div class="stat-card"><div class="label">异常</div><div class="value red" id="statError">-</div></div>
      <div class="stat-card"><div class="label">额度耗尽</div><div class="value" style="color:#f97316" id="statExhausted">-</div></div>
      <div class="stat-card"><div class="label">已禁用</div><div class="value yellow" id="statDisabled">-</div></div>
    </div>

    <!-- Toolbar -->
    <div class="toolbar">
      <div class="left">
        <button class="btn btn-primary" onclick="showAddModal()">+ 添加账号</button>
        <button class="btn btn-secondary" onclick="checkAllBalances()" id="btnCheckAll">查询全部额度</button>
        <button class="btn btn-secondary" onclick="refreshAllTokens()" id="btnRefreshAll">刷新全部Token</button>
      </div>
      <button class="btn btn-secondary btn-sm" onclick="loadAccounts()">刷新列表</button>
    </div>

    <!-- Table -->
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>邮箱</th>
            <th>标签</th>
            <th>状态</th>
            <th>使用率</th>
            <th>剩余额度</th>
            <th>上次检查</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody id="accountsBody">
          <tr><td colspan="7" class="empty-state"><p>加载中...</p></td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- Add Account Modal -->
  <div class="modal-overlay hidden" id="addModal">
    <div class="modal">
      <h2>添加账号</h2>
      <div class="modal-tabs">
        <button class="modal-tab active" data-tab="auth_json">auth.json</button>
        <button class="modal-tab" data-tab="auth_v2">auth.v2</button>
        <button class="modal-tab" data-tab="apikey">API Key</button>
      </div>

      <!-- auth.json tab -->
      <div class="tab-pane active" id="tabAuthJson">
        <div class="form-group">
          <label>上传文件</label>
          <div class="file-upload-area" id="authJsonFileArea">
            <input type="file" accept=".json" onchange="onFileSelected(this, 'authJsonInput', 'authJsonFileArea')">
            <div class="hint" id="authJsonFileHint">点击或拖拽上传 auth.json</div>
          </div>
          <div class="input-divider">或手动粘贴</div>
          <textarea id="authJsonInput" placeholder='{ "access_token": "...", "refresh_token": "..." }' rows="5"></textarea>
        </div>
      </div>

      <!-- auth.v2 tab -->
      <div class="tab-pane" id="tabAuthV2">
        <div class="form-group">
          <label>auth.v2.file</label>
          <div class="file-upload-area" id="v2FileArea">
            <input type="file" onchange="onFileSelected(this, 'v2FileInput', 'v2FileArea')">
            <div class="hint" id="v2FileHint">点击或拖拽上传 auth.v2.file</div>
          </div>
          <div class="input-divider">或手动粘贴</div>
          <textarea id="v2FileInput" placeholder="IV:AuthTag:Ciphertext (Base64)" rows="3"></textarea>
        </div>
        <div class="form-group">
          <label>auth.v2.key</label>
          <div class="file-upload-area" id="v2KeyArea">
            <input type="file" onchange="onFileSelected(this, 'v2KeyInput', 'v2KeyArea')">
            <div class="hint" id="v2KeyHint">点击或拖拽上传 auth.v2.key</div>
          </div>
          <div class="input-divider">或手动粘贴</div>
          <input type="text" id="v2KeyInput" placeholder="Base64 编码的密钥">
        </div>
      </div>

      <!-- API Key tab -->
      <div class="tab-pane" id="tabApiKey">
        <div class="form-group">
          <label>API Key</label>
          <input type="text" id="apiKeyInput" placeholder="请输入 API Key（如 FACTORY_API_KEY）">
        </div>
      </div>

      <!-- Shared fields -->
      <div class="form-group">
        <label for="labelInput">标签（可选）</label>
        <input type="text" id="labelInput" placeholder="例如：团队账号1">
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" onclick="hideAddModal()">取消</button>
        <button class="btn btn-primary" onclick="addAccount()" id="btnAdd">添加</button>
      </div>
    </div>
  </div>

  <!-- Toast -->
  <div class="toast" id="toast"></div>

  <script>
    let autoRefreshTimer = null;

    // ── API Helpers ──
    async function api(method, path, body = null) {
      const opts = { method, headers: {} };
      if (body) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
      const res = await fetch(path, opts);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || '请求失败');
      return data;
    }

    function toast(msg, type = 'success') {
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.className = 'toast ' + type + ' show';
      setTimeout(() => { el.className = 'toast'; }, 3000);
    }

    // ── Data Loading ──
    async function loadAccounts() {
      try {
        const data = await api('GET', '/admin/api/accounts');
        renderAccounts(data.accounts);
        loadStatus();
      } catch (e) {
        if (e.message.includes('Unauthorized')) {
          window.location.href = '/admin';
          return;
        }
        toast(e.message, 'error');
      }
    }

    async function loadStatus() {
      try {
        const data = await api('GET', '/admin/api/status');
        document.getElementById('statTotal').textContent = data.total;
        document.getElementById('statActive').textContent = data.active;
        document.getElementById('statError').textContent = data.error;
        document.getElementById('statExhausted').textContent = data.exhausted || 0;
        document.getElementById('statDisabled').textContent = data.disabled;
      } catch (e) { /* ignore */ }
    }

    // ── Rendering ──
    function renderAccounts(accounts) {
      const tbody = document.getElementById('accountsBody');
      if (!accounts || accounts.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty-state"><p>暂无账号，点击"添加账号"开始使用</p></td></tr>';
        return;
      }
      tbody.innerHTML = accounts.map(a => {
        const ratio = a.cached_balance ? a.cached_balance.usedRatio : null;
        const ratioPercent = ratio !== null ? (ratio * 100).toFixed(1) : '-';
        const progressClass = ratio === null ? 'low' : ratio < 0.5 ? 'low' : ratio < 0.8 ? 'mid' : 'high';
        const progressWidth = ratio !== null ? Math.min(ratio * 100, 100) : 0;

        const remaining = a.cached_balance
          ? formatTokens(a.cached_balance.totalAllowance - a.cached_balance.orgTotalTokensUsed)
          : '-';

        const lastChecked = a.cached_balance?.lastChecked
          ? timeAgo(a.cached_balance.lastChecked)
          : '从未';

        const statusMap = {
          active: '<span class="badge badge-active">活跃</span>',
          error: '<span class="badge badge-error" title="' + esc(a.error_message || '') + '">异常</span>',
          forbidden: '<span class="badge badge-forbidden" title="' + esc(a.error_message || '') + '">封禁</span>',
          exhausted: '<span class="badge badge-exhausted" title="' + esc(a.error_message || '') + '">额度耗尽</span>',
          checking: '<span class="badge badge-checking">验证中</span>',
          disabled: '<span class="badge badge-disabled">已禁用</span>'
        };
        let statusBadge = statusMap[a.status] || statusMap.error;
        if (a.cooldown) {
          const cdSec = Math.max(0, Math.ceil((a.cooldown.until - Date.now()) / 1000));
          statusBadge += ' <span class="badge badge-cooldown" title="' + esc(a.cooldown.reason) + '">冷却' + cdSec + 's</span>';
        }

        const isApiKey = a.type === 'apikey';
        const typeBadge = isApiKey ? ' <span class="text-muted">[Key]</span>' : '';
        const emailDisplay = isApiKey ? (a.label || 'API Key') : (a.email || '-');

        return '<tr>' +
          '<td class="text-ellipsis" title="' + esc(a.email || a.label || '') + '">' + esc(emailDisplay) + typeBadge + '</td>' +
          '<td>' + esc(a.label || '-') + '</td>' +
          '<td>' + statusBadge + '</td>' +
          '<td><div class="progress-bar"><div class="progress-track"><div class="progress-fill ' + progressClass + '" style="width:' + progressWidth + '%"></div></div><span class="progress-text">' + ratioPercent + '%</span></div></td>' +
          '<td>' + remaining + '</td>' +
          '<td class="text-muted">' + lastChecked + '</td>' +
          '<td><div class="cell-actions">' +
            '<button class="btn btn-secondary btn-sm" onclick="checkBalance(\\'' + a.id + '\\')">查额度</button>' +
            (isApiKey ? '' : '<button class="btn btn-secondary btn-sm" onclick="refreshToken(\\'' + a.id + '\\')">刷新</button>') +
            (a.status === 'active'
              ? '<button class="btn btn-secondary btn-sm" onclick="toggleStatus(\\'' + a.id + '\\', \\'disabled\\')">禁用</button>'
              : '<button class="btn btn-secondary btn-sm" onclick="toggleStatus(\\'' + a.id + '\\', \\'active\\')">启用</button>') +
            '<button class="btn btn-danger btn-sm" onclick="deleteAccount(\\'' + a.id + '\\')">删除</button>' +
          '</div></td>' +
        '</tr>';
      }).join('');
    }

    function formatTokens(n) {
      if (n === null || n === undefined) return '-';
      if (n >= 1e8) return (n / 1e8).toFixed(1) + ' 亿';
      if (n >= 1e4) return (n / 1e4).toFixed(0) + ' 万';
      return n.toString();
    }

    function timeAgo(ts) {
      const diff = Date.now() - ts;
      const sec = Math.floor(diff / 1000);
      if (sec < 60) return sec + '秒前';
      const min = Math.floor(sec / 60);
      if (min < 60) return min + '分钟前';
      const hr = Math.floor(min / 60);
      if (hr < 24) return hr + '小时前';
      return Math.floor(hr / 24) + '天前';
    }

    function esc(s) {
      if (!s) return '';
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // ── Actions ──
    let currentAddTab = 'auth_json';

    // Tab switching
    document.querySelectorAll('.modal-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        currentAddTab = tab;
        document.querySelectorAll('.modal-tab').forEach(el => el.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach(el => el.classList.remove('active'));
        btn.classList.add('active');
        const paneMap = { auth_json: 'tabAuthJson', auth_v2: 'tabAuthV2', apikey: 'tabApiKey' };
        document.getElementById(paneMap[tab]).classList.add('active');
      });
    });

    // File upload handler: read file content into a textarea/input
    function onFileSelected(fileInput, targetId, areaId) {
      const file = fileInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        document.getElementById(targetId).value = e.target.result;
        const area = document.getElementById(areaId);
        area.classList.add('has-file');
        // Replace hint with filename
        const hint = area.querySelector('.hint');
        if (hint) hint.innerHTML = '<span class="filename">' + esc(file.name) + '</span> 已选择';
      };
      reader.readAsText(file);
    }

    function resetFileArea(areaId, hintText) {
      const area = document.getElementById(areaId);
      if (!area) return;
      area.classList.remove('has-file');
      const hint = area.querySelector('.hint');
      if (hint) hint.textContent = hintText;
      const inp = area.querySelector('input[type=file]');
      if (inp) inp.value = '';
    }

    function showAddModal() {
      document.getElementById('addModal').classList.remove('hidden');
      // Reset all fields
      document.getElementById('authJsonInput').value = '';
      document.getElementById('v2FileInput').value = '';
      document.getElementById('v2KeyInput').value = '';
      document.getElementById('apiKeyInput').value = '';
      document.getElementById('labelInput').value = '';
      resetFileArea('authJsonFileArea', '点击或拖拽上传 auth.json');
      resetFileArea('v2FileArea', '点击或拖拽上传 auth.v2.file');
      resetFileArea('v2KeyArea', '点击或拖拽上传 auth.v2.key');
      // Reset to first tab
      currentAddTab = 'auth_json';
      document.querySelectorAll('.modal-tab').forEach(el => el.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(el => el.classList.remove('active'));
      document.querySelector('.modal-tab[data-tab="auth_json"]').classList.add('active');
      document.getElementById('tabAuthJson').classList.add('active');
    }

    function hideAddModal() {
      document.getElementById('addModal').classList.add('hidden');
    }

    async function addAccount() {
      const btn = document.getElementById('btnAdd');
      btn.disabled = true;
      try {
        const label = document.getElementById('labelInput').value.trim();
        let body;

        if (currentAddTab === 'apikey') {
          const apiKey = document.getElementById('apiKeyInput').value.trim();
          if (!apiKey) throw new Error('请输入 API Key');
          body = { type: 'apikey', apiKey, label };
        } else if (currentAddTab === 'auth_v2') {
          const v2File = document.getElementById('v2FileInput').value.trim();
          const v2Key = document.getElementById('v2KeyInput').value.trim();
          if (!v2File) throw new Error('请提供 auth.v2.file 的内容');
          if (!v2Key) throw new Error('请提供 auth.v2.key 的内容');
          body = { type: 'auth_v2', v2File, v2Key, label };
        } else {
          const raw = document.getElementById('authJsonInput').value.trim();
          if (!raw) throw new Error('请提供 auth.json 的内容');
          const authData = JSON.parse(raw);
          body = { type: 'auth_json', authData, label };
        }

        const res = await api('POST', '/admin/api/accounts', body);
        const st = res.account?.status;
        if (st === 'active') {
          toast('账号添加成功，状态：活跃');
        } else if (st === 'exhausted') {
          toast('账号已添加，但额度已耗尽', 'error');
        } else if (st === 'error') {
          toast('账号已添加，但验证失败: ' + (res.account?.error_message || '未知错误'), 'error');
        } else {
          toast('账号已添加，状态：' + (st || '未知'));
        }
        hideAddModal();
        loadAccounts();
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        btn.disabled = false;
      }
    }

    async function deleteAccount(id) {
      if (!confirm('确定要删除该账号吗？此操作不可恢复。')) return;
      try {
        await api('DELETE', '/admin/api/accounts/' + id);
        toast('账号已删除');
        loadAccounts();
      } catch (e) { toast(e.message, 'error'); }
    }

    async function toggleStatus(id, status) {
      try {
        await api('PATCH', '/admin/api/accounts/' + id, { status });
        toast('状态已更新');
        loadAccounts();
      } catch (e) { toast(e.message, 'error'); }
    }

    async function checkBalance(id) {
      try {
        toast('正在查询额度...');
        await api('POST', '/admin/api/accounts/' + id + '/check-balance');
        toast('额度已更新');
        loadAccounts();
      } catch (e) { toast(e.message, 'error'); }
    }

    async function refreshToken(id) {
      try {
        toast('正在刷新Token...');
        await api('POST', '/admin/api/accounts/' + id + '/refresh-token');
        toast('Token已刷新');
        loadAccounts();
      } catch (e) { toast(e.message, 'error'); }
    }

    async function checkAllBalances() {
      const btn = document.getElementById('btnCheckAll');
      btn.disabled = true;
      try {
        toast('正在查询所有账号额度...');
        const data = await api('POST', '/admin/api/check-all-balances');
        const failed = data.results.filter(r => !r.success).length;
        toast(failed ? failed + ' 个失败，其余已更新' : '所有额度已更新');
        loadAccounts();
      } catch (e) { toast(e.message, 'error'); }
      finally { btn.disabled = false; }
    }

    async function refreshAllTokens() {
      const btn = document.getElementById('btnRefreshAll');
      btn.disabled = true;
      try {
        toast('正在刷新所有Token...');
        const data = await api('POST', '/admin/api/refresh-all-tokens');
        const failed = data.results.filter(r => !r.success).length;
        toast(failed ? failed + ' 个失败，其余已刷新' : '所有Token已刷新');
        loadAccounts();
      } catch (e) { toast(e.message, 'error'); }
      finally { btn.disabled = false; }
    }

    async function logout() {
      try {
        await api('POST', '/admin/api/logout');
      } catch (_) {}
      window.location.href = '/admin';
    }

    // ── Init ──
    loadAccounts();
    autoRefreshTimer = setInterval(loadAccounts, 60000);
  </script>
</body>
</html>`;
}
