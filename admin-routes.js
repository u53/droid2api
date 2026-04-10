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
  initializeAccount,
  removeAccount,
  updateAccount,
  checkBalanceById,
  checkAllBalances,
  refreshTokenById,
  refreshAllTokens,
  getSystemStatus
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

// Add account (auth.json or API Key)
// Creates account in 'checking' state, then verifies (refresh token + check balance)
adminRouter.post('/admin/api/accounts', requireAuth, async (req, res) => {
  try {
    const { authData, apiKey, label, type } = req.body;

    let account;
    if (type === 'apikey' || apiKey) {
      const key = apiKey || '';
      account = addApiKeyAccount(key, label);
    } else {
      if (!authData || typeof authData !== 'object') {
        return res.status(400).json({ error: 'Bad Request', message: '请提供 authData 对象或 apiKey 字符串' });
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

// System status
adminRouter.get('/admin/api/status', requireAuth, (req, res) => {
  res.json(getSystemStatus());
});

export default adminRouter;
