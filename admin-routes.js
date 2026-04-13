import { Router } from 'express';
import {
  verifyCredentials,
  createSession,
  destroySession,
  requireAuth,
  requireAuthPage
} from './admin-auth.js';
import {
  getAllAccounts,
  addAccount,
  addApiKeyAccount,
  decryptAuthV2,
  initializeAccount,
  removeAccount,
  updateAccount,
  checkBalanceById,
  checkAllBalances,
  refreshTokenById,
  refreshAllTokens,
  getSystemStatus,
  getAccountAuthJson,
  clearExhaustedAccounts
} from './account-manager.js';
import { getLoginPage, getDashboardPage } from './admin-ui.js';
import { logError } from './logger.js';

const adminRouter = Router();

// ────────────────────────────────────────
// Page Routes
// ────────────────────────────────────────

// Login page
adminRouter.get('/admin', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getLoginPage());
});

// Dashboard page (requires auth)
adminRouter.get('/admin/dashboard', requireAuthPage, (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getDashboardPage());
});

// ────────────────────────────────────────
// Public API Routes
// ────────────────────────────────────────

// Login
adminRouter.post('/admin/api/login', (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Bad Request', message: 'Username and password required' });
    }
    if (!verifyCredentials(username, password)) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Invalid credentials' });
    }
    const sessionId = createSession(username);
    res.setHeader('Set-Cookie', `admin_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=86400`);
    res.json({ success: true, message: 'Logged in' });
  } catch (error) {
    logError('Login error', error);
    res.status(500).json({ error: 'Internal error', message: error.message });
  }
});

// ────────────────────────────────────────
// Authenticated API Routes
// ────────────────────────────────────────

// Logout
adminRouter.post('/admin/api/logout', requireAuth, (req, res) => {
  destroySession(req.adminSession);
  res.setHeader('Set-Cookie', 'admin_session=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0');
  res.json({ success: true });
});

// List accounts
adminRouter.get('/admin/api/accounts', requireAuth, (req, res) => {
  res.json({ accounts: getAllAccounts() });
});

// Add account (auth.json / auth.v2 / API Key)
// Creates account in 'checking' state, then verifies (refresh token + check balance)
adminRouter.post('/admin/api/accounts', requireAuth, async (req, res) => {
  try {
    const { authData, apiKey, v2File, v2Key, label, type } = req.body;

    let account;
    if (type === 'apikey') {
      account = addApiKeyAccount(apiKey || '', label);
    } else if (type === 'auth_v2') {
      // Decrypt auth.v2 files then create account
      if (!v2File || !v2Key) {
        return res.status(400).json({ error: 'Bad Request', message: '请提供 auth.v2.file 和 auth.v2.key 的内容' });
      }
      const decrypted = decryptAuthV2(v2File, v2Key);
      account = addAccount(decrypted, label);
    } else {
      // auth_json (default)
      if (!authData || typeof authData !== 'object') {
        return res.status(400).json({ error: 'Bad Request', message: '请提供 auth.json 内容' });
      }
      account = addAccount(authData, label);
    }

    // Initialize: refresh token + check balance, set final status
    const result = await initializeAccount(account.id);

    res.json({
      success: true,
      account: {
        id: result.id,
        email: result.email,
        type: result.type,
        status: result.status,
        error_message: result.error_message
      }
    });
  } catch (error) {
    logError('Add account error', error);
    res.status(400).json({ error: 'Bad Request', message: error.message });
  }
});

// Delete account
adminRouter.delete('/admin/api/accounts/:id', requireAuth, (req, res) => {
  try {
    removeAccount(req.params.id);
    res.json({ success: true });
  } catch (error) {
    logError('Delete account error', error);
    res.status(404).json({ error: 'Not Found', message: error.message });
  }
});

// Update account (label, status)
adminRouter.patch('/admin/api/accounts/:id', requireAuth, (req, res) => {
  try {
    const updates = {};
    if (req.body.label !== undefined) updates.label = req.body.label;
    if (req.body.status !== undefined) updates.status = req.body.status;
    updateAccount(req.params.id, updates);
    res.json({ success: true });
  } catch (error) {
    logError('Update account error', error);
    res.status(400).json({ error: 'Bad Request', message: error.message });
  }
});

// Check single account balance
adminRouter.post('/admin/api/accounts/:id/check-balance', requireAuth, async (req, res) => {
  try {
    const balance = await checkBalanceById(req.params.id);
    res.json({ success: true, balance });
  } catch (error) {
    logError('Check balance error', error);
    res.status(400).json({ error: 'Error', message: error.message });
  }
});

// Check all balances
adminRouter.post('/admin/api/check-all-balances', requireAuth, async (req, res) => {
  try {
    const results = await checkAllBalances();
    res.json({ success: true, results });
  } catch (error) {
    logError('Check all balances error', error);
    res.status(500).json({ error: 'Error', message: error.message });
  }
});

// Refresh single account token
adminRouter.post('/admin/api/accounts/:id/refresh-token', requireAuth, async (req, res) => {
  try {
    await refreshTokenById(req.params.id);
    res.json({ success: true });
  } catch (error) {
    logError('Refresh token error', error);
    res.status(400).json({ error: 'Error', message: error.message });
  }
});

// Refresh all tokens
adminRouter.post('/admin/api/refresh-all-tokens', requireAuth, async (req, res) => {
  try {
    const results = await refreshAllTokens();
    res.json({ success: true, results });
  } catch (error) {
    logError('Refresh all tokens error', error);
    res.status(500).json({ error: 'Error', message: error.message });
  }
});

// Get account auth.json for copy/export
adminRouter.get('/admin/api/accounts/:id/auth-json', requireAuth, (req, res) => {
  try {
    const authJson = getAccountAuthJson(req.params.id);
    res.json({ success: true, authJson });
  } catch (error) {
    logError('Get auth json error', error);
    res.status(404).json({ error: 'Not Found', message: error.message });
  }
});

// Clear all exhausted accounts
adminRouter.post('/admin/api/clear-exhausted', requireAuth, async (req, res) => {
  try {
    const result = await clearExhaustedAccounts();
    res.json({ success: true, ...result });
  } catch (error) {
    logError('Clear exhausted accounts error', error);
    res.status(500).json({ error: 'Error', message: error.message });
  }
});

// System status
adminRouter.get('/admin/api/status', requireAuth, (req, res) => {
  res.json(getSystemStatus());
});

// ────────────────────────────────────────
// Open API: push RT Token without login
// Header: X-Push-Token: droid2api-open-push-token
// ────────────────────────────────────────
const OPEN_PUSH_TOKEN = process.env.OPEN_PUSH_TOKEN || 'droid2api-open-push-token';

adminRouter.post('/open/api/push-token', async (req, res) => {
  try {
    const pushToken = req.headers['x-push-token'];
    if (!pushToken || pushToken !== OPEN_PUSH_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or missing X-Push-Token header' });
    }

    const { rttoken, rttokens, label } = req.body;
    const tokenList = rttokens || (rttoken ? [rttoken] : []);

    if (!tokenList.length) {
      return res.status(400).json({ error: 'Bad Request', message: 'Provide rttoken (string) or rttokens (array)' });
    }

    const results = [];
    for (const token of tokenList) {
      const t = (typeof token === 'string' ? token : '').trim();
      if (!t) { results.push({ rttoken: token, success: false, message: 'Empty token' }); continue; }
      try {
        const account = addAccount({ refresh_token: t }, label || '');
        const result = await initializeAccount(account.id);
        // Deduplicate by email: if another account with the same email already exists, remove the new one
        if (result.email) {
          const all = getAllAccounts();
          const dup = all.find(a => a.id !== result.id && a.email === result.email);
          if (dup) {
            removeAccount(result.id);
            results.push({ rttoken: t.slice(0, 8) + '...', success: true, skipped: true, message: 'Duplicate email, skipped', email: result.email });
            continue;
          }
        }
        results.push({ rttoken: t.slice(0, 8) + '...', success: true, id: result.id, email: result.email, status: result.status });
      } catch (e) {
        results.push({ rttoken: t.slice(0, 8) + '...', success: false, message: e.message });
      }
    }

    res.json({ success: true, count: results.length, results });
  } catch (error) {
    logError('Open API push-token error', error);
    res.status(500).json({ error: 'Internal Error', message: error.message });
  }
});

// ────────────────────────────────────────
// Open API: get exhausted account emails
// Header: X-Push-Token: droid2api-open-push-token
// ────────────────────────────────────────
adminRouter.get('/open/api/exhausted-emails', (req, res) => {
  try {
    const pushToken = req.headers['x-push-token'];
    if (!pushToken || pushToken !== OPEN_PUSH_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or missing X-Push-Token header' });
    }

    const all = getAllAccounts();
    const exhausted = all
      .filter(a => a.status === 'exhausted')
      .map(a => a.email)
      .filter(Boolean);

    res.json({ success: true, count: exhausted.length, emails: exhausted });
  } catch (error) {
    logError('Open API exhausted-emails error', error);
    res.status(500).json({ error: 'Internal Error', message: error.message });
  }
});

export default adminRouter;
