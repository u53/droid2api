import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import crypto from 'crypto';
import { logDebug, logError, logInfo } from './logger.js';
import { getNextProxyAgent } from './proxy-manager.js';

// Constants
const ACCOUNTS_FILE = path.join(process.cwd(), 'accounts.json');
const REFRESH_URL = 'https://api.workos.com/user_management/authenticate';
const BALANCE_URL = 'https://app.factory.ai/api/organization/members/chat-usage';
const CLIENT_ID = 'client_01HNM792M5G5G1A2THWPXKFMXB';

// In-memory state
let accounts = [];
let dataVersion = 1;
let backgroundTimers = [];

// ────────────────────────────────────────
// Persistence
// ────────────────────────────────────────

function loadAccounts() {
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      const raw = fs.readFileSync(ACCOUNTS_FILE, 'utf-8');
      const data = JSON.parse(raw);
      accounts = data.accounts || [];
      dataVersion = data.version || 1;
      logInfo(`Loaded ${accounts.length} managed account(s) from accounts.json`);
    } else {
      accounts = [];
      logInfo('No accounts.json found, starting with empty account list');
    }
  } catch (error) {
    logError('Failed to load accounts.json', error);
    accounts = [];
  }
}

function saveAccounts() {
  try {
    const data = { accounts, version: dataVersion };
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2), 'utf-8');
    logDebug(`Saved ${accounts.length} account(s) to accounts.json`);
  } catch (error) {
    logError('Failed to save accounts.json', error);
  }
}

// ────────────────────────────────────────
// CRUD
// ────────────────────────────────────────

function generateAccountId() {
  return 'acc_' + crypto.randomBytes(8).toString('hex');
}

/**
 * Check if there are any managed accounts
 */
export function hasAccounts() {
  return accounts.length > 0;
}

/**
 * Get all accounts (sanitized for API responses)
 */
export function getAllAccounts() {
  return accounts.map(a => ({
    id: a.id,
    type: a.type || 'auth_json',
    email: a.email || '',
    label: a.label || '',
    status: a.status,
    error_message: a.error_message,
    cached_balance: a.cached_balance,
    created_at: a.created_at,
    last_refresh: a.last_refresh,
    exp: a.exp
  }));
}

/**
 * Add account from auth.json content (with refresh_token)
 * Initial status is 'checking', will be set after verification
 */
export function addAccount(authData, label = '') {
  if (!authData.refresh_token) {
    throw new Error('auth.json 必须包含 refresh_token 字段');
  }

  // Check for duplicate by refresh_token
  const existing = accounts.find(a => a.refresh_token === authData.refresh_token);
  if (existing) {
    throw new Error(`账号已存在 (${existing.email || existing.id})`);
  }

  const account = {
    id: generateAccountId(),
    type: 'auth_json',
    email: authData.email || '',
    access_token: authData.access_token || '',
    refresh_token: authData.refresh_token,
    exp: authData.exp || 0,
    last_refresh: 0,
    cached_balance: null,
    status: 'checking',
    error_message: null,
    created_at: Date.now(),
    label: label || ''
  };

  accounts.push(account);
  saveAccounts();
  logInfo(`Added auth_json account: ${account.id} (${account.email || 'no email'}), verifying...`);
  return account;
}

/**
 * Add account with a direct API Key (no refresh needed)
 * Initial status is 'checking', will be set after verification
 */
export function addApiKeyAccount(apiKey, label = '') {
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new Error('API Key 不能为空');
  }

  const key = apiKey.trim();

  // Check for duplicate
  const existing = accounts.find(a => a.type === 'apikey' && a.access_token === key);
  if (existing) {
    throw new Error(`该 API Key 已存在 (${existing.label || existing.id})`);
  }

  const account = {
    id: generateAccountId(),
    type: 'apikey',
    email: '',
    access_token: key,
    refresh_token: '',
    exp: 0,
    last_refresh: 0,
    cached_balance: null,
    status: 'checking',
    error_message: null,
    created_at: Date.now(),
    label: label || ''
  };

  accounts.push(account);
  saveAccounts();
  logInfo(`Added apikey account: ${account.id} (${account.label || 'no label'}), verifying...`);
  return account;
}

/**
 * Initialize a newly added account: refresh token (if needed) + check balance
 * Sets status to active / exhausted / error based on result
 */
export async function initializeAccount(id) {
  const account = getAccountById(id);
  if (!account) throw new Error(`Account not found: ${id}`);

  logInfo(`Initializing account ${account.id}...`);

  // Step 1: Refresh token (auth_json accounts only)
  if (account.type === 'auth_json') {
    try {
      await refreshAccountToken(account);
      logInfo(`Token refreshed for new account ${account.id} (${account.email || 'no email'})`);
    } catch (error) {
      account.status = 'error';
      account.error_message = 'Token 刷新失败: ' + error.message;
      saveAccounts();
      logError(`Init failed for ${account.id}: token refresh error`, error);
      return account;
    }
  }

  // Step 2: Check balance
  try {
    await checkAccountBalance(account);
    // checkAccountBalance will set status to exhausted if needed
    if (account.status !== 'exhausted') {
      account.status = 'active';
      account.error_message = null;
    }
    saveAccounts();
    logInfo(`Account ${account.id} initialized: status=${account.status}, usage=${((account.cached_balance?.usedRatio ?? 0) * 100).toFixed(1)}%`);
  } catch (error) {
    account.status = 'error';
    account.error_message = '额度查询失败: ' + error.message;
    saveAccounts();
    logError(`Init failed for ${account.id}: balance check error`, error);
  }

  return account;
}

/**
 * Remove account by ID
 */
export function removeAccount(id) {
  const idx = accounts.findIndex(a => a.id === id);
  if (idx === -1) {
    throw new Error(`Account not found: ${id}`);
  }
  const removed = accounts.splice(idx, 1)[0];
  saveAccounts();
  logInfo(`Removed account: ${id} (${removed.email || 'no email'})`);
  return removed;
}

/**
 * Update account fields (label, status)
 */
export function updateAccount(id, updates) {
  const account = accounts.find(a => a.id === id);
  if (!account) {
    throw new Error(`Account not found: ${id}`);
  }
  if (updates.label !== undefined) account.label = updates.label;
  if (updates.status !== undefined) {
    if (!['active', 'disabled', 'error', 'exhausted', 'checking'].includes(updates.status)) {
      throw new Error('Invalid status. Must be: active, disabled, error, exhausted, checking');
    }
    account.status = updates.status;
    if (updates.status === 'active') {
      account.error_message = null;
    }
  }
  saveAccounts();
  return account;
}

/**
 * Get account by ID (internal, includes tokens)
 */
function getAccountById(id) {
  return accounts.find(a => a.id === id) || null;
}

// ────────────────────────────────────────
// Token Refresh
// ────────────────────────────────────────

/**
 * Refresh token for a single account
 */
export async function refreshAccountToken(account) {
  if (!account.refresh_token) {
    throw new Error('No refresh token available');
  }

  logInfo(`Refreshing token for account: ${account.id} (${account.email || 'no email'})`);

  const formData = new URLSearchParams();
  formData.append('grant_type', 'refresh_token');
  formData.append('refresh_token', account.refresh_token);
  formData.append('client_id', CLIENT_ID);

  const proxyAgentInfo = getNextProxyAgent(REFRESH_URL);
  const fetchOptions = {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formData.toString()
  };
  if (proxyAgentInfo?.agent) {
    fetchOptions.agent = proxyAgentInfo.agent;
  }

  try {
    const response = await fetch(REFRESH_URL, fetchOptions);
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Token refresh failed: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    account.access_token = data.access_token;
    account.refresh_token = data.refresh_token;
    account.last_refresh = Date.now();
    account.error_message = null;

    // Parse JWT exp if possible
    try {
      const payload = JSON.parse(Buffer.from(data.access_token.split('.')[1], 'base64').toString());
      if (payload.exp) {
        account.exp = payload.exp * 1000; // convert to ms
      }
    } catch (_) { /* ignore JWT parse errors */ }

    // Extract email from user info
    if (data.user?.email) {
      account.email = data.user.email;
    }

    if (account.status === 'error') {
      account.status = 'active';
    }

    saveAccounts();
    logInfo(`Token refreshed for: ${account.id} (${account.email || 'no email'})`);
    return true;
  } catch (error) {
    account.status = 'error';
    account.error_message = error.message;
    saveAccounts();
    logError(`Token refresh failed for ${account.id}`, error);
    throw error;
  }
}

/**
 * Refresh token by account ID (for API endpoint)
 */
export async function refreshTokenById(id) {
  const account = getAccountById(id);
  if (!account) throw new Error(`Account not found: ${id}`);
  return await refreshAccountToken(account);
}

/**
 * Refresh all active account tokens
 */
export async function refreshAllTokens() {
  const results = [];
  for (const account of accounts) {
    if (account.status === 'disabled') continue;
    if (account.type === 'apikey') continue; // API Key 账号无需刷新
    try {
      await refreshAccountToken(account);
      results.push({ id: account.id, success: true });
    } catch (error) {
      results.push({ id: account.id, success: false, error: error.message });
    }
  }
  return results;
}

// ────────────────────────────────────────
// Balance Checking
// ────────────────────────────────────────

/**
 * Check balance for a single account
 */
export async function checkAccountBalance(account) {
  if (!account.access_token) {
    throw new Error('No access token available, refresh token first');
  }

  logDebug(`Checking balance for: ${account.id}`);

  const proxyAgentInfo = getNextProxyAgent(BALANCE_URL);
  const fetchOptions = {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${account.access_token}`,
      'Accept': 'application/json'
    }
  };
  if (proxyAgentInfo?.agent) {
    fetchOptions.agent = proxyAgentInfo.agent;
  }

  try {
    const response = await fetch(BALANCE_URL, fetchOptions);
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Balance check failed: ${response.status} ${errorText}`);
    }

    const data = await response.json();

    // Parse usage data - try standard usage path
    const usage = data?.usage?.standard || data?.standard || data;
    const totalAllowance = usage?.totalAllowance || 0;
    const orgTotalTokensUsed = usage?.orgTotalTokensUsed || 0;
    const usedRatio = totalAllowance > 0 ? orgTotalTokensUsed / totalAllowance : 0;

    account.cached_balance = {
      totalAllowance,
      orgTotalTokensUsed,
      usedRatio,
      lastChecked: Date.now()
    };

    // Auto-set status based on usage
    if (usedRatio >= 0.95) {
      if (account.status !== 'disabled') {
        account.status = 'exhausted';
        account.error_message = `额度已用完 (${(usedRatio * 100).toFixed(1)}%)`;
        logInfo(`Account ${account.id} marked as exhausted: ${(usedRatio * 100).toFixed(1)}% used`);
      }
    } else if (account.status === 'exhausted') {
      // Recovered from exhausted
      account.status = 'active';
      account.error_message = null;
      logInfo(`Account ${account.id} recovered from exhausted: ${(usedRatio * 100).toFixed(1)}% used`);
    }

    saveAccounts();
    logDebug(`Balance for ${account.id}: ${(usedRatio * 100).toFixed(2)}% used`);
    return account.cached_balance;
  } catch (error) {
    logError(`Balance check failed for ${account.id}`, error);
    throw error;
  }
}

/**
 * Check balance by account ID (for API endpoint)
 */
export async function checkBalanceById(id) {
  const account = getAccountById(id);
  if (!account) throw new Error(`Account not found: ${id}`);
  const prevStatus = account.status;
  const balance = await checkAccountBalance(account);
  // Manual check succeeded: if was error/checking, recover to active (unless exhausted)
  if ((prevStatus === 'error' || prevStatus === 'checking') && account.status !== 'exhausted') {
    account.status = 'active';
    account.error_message = null;
    saveAccounts();
    logInfo(`Account ${account.id} recovered to active after manual balance check`);
  }
  return balance;
}

/**
 * Check all active account balances
 */
export async function checkAllBalances() {
  const results = [];
  for (const account of accounts) {
    if (account.status === 'disabled') continue;
    if (!account.access_token) continue;
    try {
      const balance = await checkAccountBalance(account);
      results.push({ id: account.id, success: true, balance });
    } catch (error) {
      results.push({ id: account.id, success: false, error: error.message });
    }
  }
  return results;
}

// ────────────────────────────────────────
// Scheduling Algorithm
// ────────────────────────────────────────

/**
 * Get next API key using smart scheduling
 * Priority: lowest usage ratio among active, non-exhausted accounts
 */
export async function getNextApiKey() {
  // 1. Filter active accounts
  const active = accounts.filter(a => a.status === 'active');
  if (active.length === 0) {
    throw new Error('No active managed accounts available');
  }

  // 2. Exclude exhausted accounts (usedRatio >= 0.95)
  const available = active.filter(a => {
    if (!a.cached_balance) return true; // no balance info yet, assume OK
    return a.cached_balance.usedRatio < 0.95;
  });

  if (available.length === 0) {
    throw new Error('All managed accounts have exhausted their quota (>=95% used)');
  }

  // 3. Exclude accounts with no access token and no refresh token
  const usable = available.filter(a => a.access_token || a.refresh_token);
  if (usable.length === 0) {
    throw new Error('No usable managed accounts (missing tokens)');
  }

  // 4. Sort by usage ratio ascending (lowest first)
  usable.sort((a, b) => {
    const ratioA = a.cached_balance?.usedRatio ?? 0;
    const ratioB = b.cached_balance?.usedRatio ?? 0;
    return ratioA - ratioB;
  });

  // 5. Try accounts in order
  for (const account of usable) {
    try {
      // API Key accounts: always usable as long as they have a token
      if (account.type === 'apikey') {
        if (!account.access_token) {
          logDebug(`Skipping apikey account ${account.id}: empty key`);
          continue;
        }
        logDebug(`Scheduled apikey account: ${account.id} (${account.label || 'no label'}, usage: ${((account.cached_balance?.usedRatio ?? 0) * 100).toFixed(1)}%)`);
        return `Bearer ${account.access_token}`;
      }

      // auth_json accounts: check if token is expired or about to expire (< 30 min)
      const now = Date.now();
      const tokenExpired = account.exp && account.exp < now + 30 * 60 * 1000;
      const noToken = !account.access_token;

      if (tokenExpired || noToken) {
        if (account.refresh_token) {
          logInfo(`Token expired/missing for ${account.id}, refreshing...`);
          await refreshAccountToken(account);
        } else {
          logDebug(`Skipping ${account.id}: no token and no refresh token`);
          continue;
        }
      }

      logDebug(`Scheduled account: ${account.id} (${account.email || 'no email'}, usage: ${((account.cached_balance?.usedRatio ?? 0) * 100).toFixed(1)}%)`);
      return `Bearer ${account.access_token}`;
    } catch (error) {
      logError(`Failed to use account ${account.id}, trying next`, error);
      continue;
    }
  }

  throw new Error('All managed accounts failed to provide a valid API key');
}

// ────────────────────────────────────────
// Background Tasks
// ────────────────────────────────────────

/**
 * Background: refresh tokens that are about to expire (< 2 hours remaining)
 */
async function backgroundRefreshTokens() {
  const now = Date.now();
  const twoHoursMs = 2 * 60 * 60 * 1000;

  for (const account of accounts) {
    if (account.status !== 'active') continue;
    if (account.type === 'apikey') continue; // API Key 账号无需刷新
    if (!account.refresh_token) continue;

    const tokenExpiringSoon = account.exp && (account.exp - now) < twoHoursMs;
    const neverRefreshed = !account.last_refresh;

    if (tokenExpiringSoon || neverRefreshed) {
      try {
        await refreshAccountToken(account);
      } catch (error) {
        logError(`Background refresh failed for ${account.id}`, error);
      }
    }
  }
}

/**
 * Background: check balance for active/exhausted/error accounts
 * This allows exhausted/error accounts to auto-recover
 */
async function backgroundCheckBalances() {
  for (const account of accounts) {
    if (account.status === 'disabled' || account.status === 'checking') continue;
    if (!account.access_token) continue;
    try {
      const prevStatus = account.status;
      await checkAccountBalance(account);
      // Auto-recover error accounts on successful balance check
      if (prevStatus === 'error' && account.status !== 'exhausted') {
        account.status = 'active';
        account.error_message = null;
        saveAccounts();
        logInfo(`Account ${account.id} auto-recovered to active`);
      }
    } catch (error) {
      logError(`Background balance check failed for ${account.id}`, error);
    }
  }
}

/**
 * Start background tasks
 */
export function startBackgroundTasks() {
  // Refresh tokens every 30 minutes
  const refreshTimer = setInterval(backgroundRefreshTokens, 30 * 60 * 1000);
  // Check balances every 15 minutes
  const balanceTimer = setInterval(backgroundCheckBalances, 15 * 60 * 1000);

  backgroundTimers.push(refreshTimer, balanceTimer);
  logInfo('Background tasks started (token refresh: 30min, balance check: 15min)');

  // Run initial check after a short delay (10 seconds)
  setTimeout(async () => {
    if (accounts.length > 0) {
      logInfo('Running initial background tasks...');
      try {
        await backgroundRefreshTokens();
        await backgroundCheckBalances();
      } catch (error) {
        logError('Initial background tasks failed', error);
      }
    }
  }, 10 * 1000);
}

/**
 * Stop background tasks
 */
export function stopBackgroundTasks() {
  for (const timer of backgroundTimers) {
    clearInterval(timer);
  }
  backgroundTimers = [];
  logInfo('Background tasks stopped');
}

// ────────────────────────────────────────
// System Status
// ────────────────────────────────────────

export function getSystemStatus() {
  const total = accounts.length;
  const active = accounts.filter(a => a.status === 'active').length;
  const error = accounts.filter(a => a.status === 'error').length;
  const disabled = accounts.filter(a => a.status === 'disabled').length;
  const exhausted = accounts.filter(a => a.status === 'exhausted').length;
  const checking = accounts.filter(a => a.status === 'checking').length;

  return {
    total,
    active,
    error,
    disabled,
    exhausted,
    checking,
    backgroundTasksRunning: backgroundTimers.length > 0
  };
}

// ────────────────────────────────────────
// Initialization
// ────────────────────────────────────────

export function initAccountManager() {
  loadAccounts();
  logInfo('Account manager initialized');
}
