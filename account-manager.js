import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import crypto from 'crypto';
import { logDebug, logError, logInfo } from './logger.js';
import { getNextProxyAgent } from './proxy-manager.js';

// Constants
const ACCOUNTS_FILE = path.join(process.cwd(), 'accounts.json');
const REFRESH_URL = 'https://api.workos.com/user_management/authenticate';
const BALANCE_URL = 'https://app.factory.ai/api/organization/members/chat-usage?interval=M';
const CLIENT_ID = 'client_01HNM792M5G5G1A2THWPXKFMXB';

// In-memory state
let accounts = [];
let dataVersion = 1;
let backgroundTimers = [];

// General cooldown removed: async health check handles real account issues (exhausted/banned/error).
// 429 is treated as transient rate limiting and does not change account state.

// Async health check: track which accounts are currently being checked to avoid duplicate checks
const pendingHealthChecks = new Set();

// Round-robin: track last-used timestamp per account to spread concurrent requests
// Map<accountId, lastUsedTimestamp>
const lastUsedMap = new Map();

// ────────────────────────────────────────
// Concurrency Control (prevent race conditions)
// ────────────────────────────────────────

// Save debounce: merge multiple saveAccounts calls into a single disk write
let saveTimer = null;
let savePending = false;
const SAVE_DEBOUNCE_MS = 200; // merge writes within 200ms

// Bulk operation mutex: prevent refreshAllTokens / checkAllBalances from running concurrently
let bulkOperationLock = Promise.resolve();

// Per-account lock: prevent concurrent token refresh and balance check on the same account
// Map<accountId, Promise>
const accountLockMap = new Map();

/**
 * Acquire bulk operation lock — ensures only one bulk operation runs at a time
 * @param {string} operationName - operation name (for logging)
 * @returns {Promise<Function>} release function, call to release the lock
 */
function acquireBulkLock(operationName) {
  let release;
  const prev = bulkOperationLock;
  bulkOperationLock = new Promise(resolve => { release = resolve; });
  return prev.then(() => {
    logDebug(`[Lock] Acquired bulk lock for: ${operationName}`);
    return () => {
      logDebug(`[Lock] Released bulk lock for: ${operationName}`);
      release();
    };
  });
}

/**
 * Acquire per-account lock — ensures the same account won't run token refresh and balance check concurrently
 * @param {string} accountId
 * @returns {Promise<Function>} release function
 */
function acquireAccountLock(accountId) {
  let release;
  const prev = accountLockMap.get(accountId) || Promise.resolve();
  const next = new Promise(resolve => { release = resolve; });
  accountLockMap.set(accountId, next);
  return prev.then(() => {
    return () => {
      // If current promise is still the latest in the map, clean it up
      if (accountLockMap.get(accountId) === next) {
        accountLockMap.delete(accountId);
      }
      release();
    };
  });
}

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

/**
 * Write to disk immediately (internal use)
 */
function saveAccountsImmediate() {
  try {
    const data = { accounts, version: dataVersion };
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2), 'utf-8');
    logDebug(`Saved ${accounts.length} account(s) to accounts.json`);
  } catch (error) {
    logError('Failed to save accounts.json', error);
  }
}

/**
 * Debounced save: merge multiple writes within a short window into a single disk operation
 * - First call writes immediately
 * - Subsequent calls within SAVE_DEBOUNCE_MS are merged into one
 */
function saveAccounts() {
  if (!savePending) {
    // First call, write immediately
    savePending = true;
    saveAccountsImmediate();
    saveTimer = setTimeout(() => {
      savePending = false;
      saveTimer = null;
    }, SAVE_DEBOUNCE_MS);
  } else {
    // Already pending, reset timer and defer writing latest state
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveAccountsImmediate();
      savePending = false;
      saveTimer = null;
    }, SAVE_DEBOUNCE_MS);
  }
}

/**
 * Force immediate save (for critical operations like add/remove account)
 */
function saveAccountsSync() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  savePending = false;
  saveAccountsImmediate();
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
  return accounts.map(a => {
    return {
      id: a.id,
      type: a.type || 'auth_json',
      email: a.email || '',
      label: a.label || '',
      status: a.status,
      error_message: a.error_message,
      cached_balance: a.cached_balance,
      created_at: a.created_at,
      last_refresh: a.last_refresh,
      exp: a.exp,
      cooldown: null
    };
  });
}

/**
 * Decrypt auth.v2 format: AES-256-GCM
 * @param {string} fileContent - content of auth.v2.file (IV:AuthTag:Ciphertext, all Base64)
 * @param {string} keyContent  - content of auth.v2.key (Base64 encoded 256-bit key)
 * @returns {object} decrypted JSON { access_token, refresh_token }
 */
export function decryptAuthV2(fileContent, keyContent) {
  try {
    const key = Buffer.from(keyContent.trim(), 'base64');
    if (key.length !== 32) {
      throw new Error(`Invalid key length: expected 32 bytes, got ${key.length} bytes`);
    }

    const parts = fileContent.trim().split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid auth.v2.file format, expected IV:AuthTag:Ciphertext (3 parts)');
    }

    const iv = Buffer.from(parts[0], 'base64');
    const authTag = Buffer.from(parts[1], 'base64');
    const encrypted = Buffer.from(parts[2], 'base64');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, null, 'utf-8');
    decrypted += decipher.final('utf-8');

    const data = JSON.parse(decrypted);
    if (!data.refresh_token) {
      throw new Error('Decrypted data is missing refresh_token field');
    }
    return data;
  } catch (error) {
    if (error.message.includes('Unsupported state') || error.code === 'ERR_OSSL_BAD_DECRYPT') {
      throw new Error('Decryption failed: key does not match the encrypted file');
    }
    throw error;
  }
}

/**
 * Add account from auth.json content (with refresh_token)
 * Initial status is 'checking', will be set after verification
 */
export function addAccount(authData, label = '') {
  if (!authData.refresh_token) {
    throw new Error('auth.json must contain a refresh_token field');
  }

  // Check for duplicate by refresh_token
  const existing = accounts.find(a => a.refresh_token === authData.refresh_token);
  if (existing) {
    throw new Error(`Account already exists (${existing.email || existing.id})`);
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
  saveAccountsSync(); // Critical: write immediately, skip debounce
  logInfo(`Added auth_json account: ${account.id} (${account.email || 'no email'}), verifying...`);
  return account;
}

/**
 * Add account with a direct API Key (no refresh needed)
 * Initial status is 'checking', will be set after verification
 */
export function addApiKeyAccount(apiKey, label = '') {
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new Error('API Key cannot be empty');
  }

  const key = apiKey.trim();

  // Check for duplicate
  const existing = accounts.find(a => a.type === 'apikey' && a.access_token === key);
  if (existing) {
    throw new Error(`API Key already exists (${existing.label || existing.id})`);
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
  saveAccountsSync(); // Critical: write immediately, skip debounce
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
      account.error_message = 'Token refresh failed: ' + error.message;
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
    if (error.statusCode === 429) {
      logInfo(`Init balance check rate-limited for ${account.id}, keeping status=${account.status}`);
    } else {
      account.status = 'error';
      account.error_message = 'Balance check failed: ' + error.message;
      saveAccounts();
      logError(`Init failed for ${account.id}: balance check error`, error);
    }
  }

  return account;
}

/**
 * Clean up in-memory state for a removed account
 */
function cleanupAccountMemory(id) {
  accountLockMap.delete(id);
  lastUsedMap.delete(id);
  pendingHealthChecks.delete(id);
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
  cleanupAccountMemory(id);
  saveAccountsSync(); // Critical: write immediately, skip debounce
  logInfo(`Removed account: ${id} (${removed.email || 'no email'})`);
  return removed;
}

/**
 * Remove all accounts with 'exhausted' status
 * Uses bulk lock to prevent concurrent modifications
 * @returns {{ removed: number, ids: string[] }}
 */
export async function clearExhaustedAccounts() {
  const releaseBulkLock = await acquireBulkLock('clearExhaustedAccounts');
  try {
    const exhausted = accounts.filter(a => a.status === 'exhausted');
    if (exhausted.length === 0) {
      return { removed: 0, ids: [] };
    }

    const removedIds = exhausted.map(a => a.id);
    const removedInfo = exhausted.map(a => `${a.id} (${a.email || a.label || 'unknown'})`);

    // Remove from array (reverse order to prevent index shift)
    for (let i = accounts.length - 1; i >= 0; i--) {
      if (accounts[i].status === 'exhausted') {
        cleanupAccountMemory(accounts[i].id);
        accounts.splice(i, 1);
      }
    }

    saveAccountsSync(); // Critical: write to disk immediately
    logInfo(`[ClearExhausted] Removed ${removedIds.length} exhausted accounts: ${removedInfo.join(', ')}`);
    return { removed: removedIds.length, ids: removedIds };
  } finally {
    releaseBulkLock();
  }
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
  saveAccountsSync(); // Admin operation: write immediately
  return account;
}

/**
 * Get account by ID (internal, includes tokens)
 */
function getAccountById(id) {
  return accounts.find(a => a.id === id) || null;
}

/**
 * Get account auth.json content for export/copy
 */
export function getAccountAuthJson(id) {
  const account = getAccountById(id);
  if (!account) throw new Error(`Account not found: ${id}`);

  if (account.type === 'apikey') {
    return { access_token: account.access_token };
  }

  return {
    access_token: account.access_token || '',
    refresh_token: account.refresh_token || '',
    exp: account.exp || 0
  };
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

  // Acquire per-account lock to prevent concurrent token refresh and balance check
  const releaseAccountLock = await acquireAccountLock(account.id);

  try {
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
  } finally {
    releaseAccountLock();
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
  const releaseBulkLock = await acquireBulkLock('refreshAllTokens');
  try {
    const results = [];
    // Copy snapshot to prevent array modification during iteration
    const snapshot = [...accounts];
    for (const account of snapshot) {
      if (account.status === 'disabled') continue;
      if (account.type === 'apikey') continue; // API Key accounts don't need refresh
      // Check if account was deleted during iteration
      if (!accounts.includes(account)) continue;
      try {
        await refreshAccountToken(account);
        results.push({ id: account.id, success: true });
      } catch (error) {
        results.push({ id: account.id, success: false, error: error.message });
      }
    }
    return results;
  } finally {
    releaseBulkLock();
  }
}

// ────────────────────────────────────────
// Concurrency Helper
// ────────────────────────────────────────

const BALANCE_CHECK_CONCURRENCY = 5;

/**
 * Run async function over items with limited concurrency.
 * @param {Array} items
 * @param {number} concurrency
 * @param {Function} fn - async (item) => result
 * @returns {Promise<PromiseSettledResult[]>}
 */
async function runWithConcurrency(items, concurrency, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    const chunkResults = await Promise.allSettled(chunk.map(fn));
    results.push(...chunkResults);
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

  // Acquire per-account lock to prevent concurrent token refresh and balance check
  const releaseAccountLock = await acquireAccountLock(account.id);

  try {
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

    const response = await fetch(BALANCE_URL, fetchOptions);
    if (!response.ok) {
      const errorText = await response.text();
      const error = new Error(`Balance check failed: ${response.status} ${errorText}`);
      error.statusCode = response.status;
      throw error;
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
    if (usedRatio >= 1.0) {
      if (account.status !== 'disabled') {
        account.status = 'exhausted';
        account.error_message = `Quota exhausted (${(usedRatio * 100).toFixed(1)}%)`;
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
  } finally {
    releaseAccountLock();
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
  const releaseBulkLock = await acquireBulkLock('checkAllBalances');
  try {
    const eligible = [...accounts].filter(a =>
      a.status !== 'disabled' && a.access_token && accounts.includes(a)
    );

    const settled = await runWithConcurrency(eligible, BALANCE_CHECK_CONCURRENCY, async (account) => {
      if (!accounts.includes(account)) return { id: account.id, success: false, error: 'Account removed' };
      const balance = await checkAccountBalance(account);
      return { id: account.id, success: true, balance };
    });

    return settled.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      return { id: eligible[i].id, success: false, error: r.reason?.message || String(r.reason) };
    });
  } finally {
    releaseBulkLock();
  }
}

// ────────────────────────────────────────
// Failure Reporting (no cooldown — async health check handles real issues)
// ────────────────────────────────────────

/**
 * Report that a request using this bearer token returned a retryable error.
 *
 * No cooldown is applied. The retry loop in routes.js uses excludeTokens to avoid
 * re-picking the same account within one request. For account-level issues (401/402/403),
 * an async health check runs in the background to determine the real cause:
 *   - If quota is exhausted → mark as 'exhausted'
 *   - If token is invalid / account banned → mark as 'error'
 *   - If it was just a transient error → account stays active, next request can use it
 *
 * 429 is purely rate limiting and transient — no health check needed, account stays active.
 *
 * @param {string} bearerToken - "Bearer xxx"
 * @param {number} statusCode - HTTP status (401/402/403/429)
 * @param {string} reason - error description
 */
export function reportAccountFailure(bearerToken, statusCode, reason) {
  if (!bearerToken) return;
  const token = bearerToken.replace(/^Bearer\s+/i, '');
  const account = accounts.find(a => a.access_token === token);
  if (!account) return;

  const trimmedReason = (reason || '').substring(0, 200);

  const reasonMap = {
    401: 'Auth failed (401)',
    402: 'Insufficient quota (402)',
    403: 'Request rejected (403)',
    429: 'Rate limited (429)'
  };

  const displayReason = reasonMap[statusCode] || `HTTP ${statusCode}`;

  logInfo(`[Failure] Account ${account.id} (${account.email || account.label || 'unknown'}): ${displayReason}`);

  // For status codes that may indicate account-level issues, async check real status (non-blocking)
  if ([401, 402, 403].includes(statusCode)) {
    asyncAccountHealthCheck(account, statusCode, trimmedReason);
  }
}

/**
 * Async health check: determine if an account failure is due to
 * quota exhaustion, account ban, or just a transient error.
 *
 * Runs in the background without blocking the main request flow.
 * Uses pendingHealthChecks to prevent duplicate concurrent checks on the same account.
 *
 * @param {object} account - The account object
 * @param {number} statusCode - The HTTP status that triggered this check
 * @param {string} errorDetail - The error detail from the failed request
 */
function asyncAccountHealthCheck(account, statusCode, errorDetail) {
  // Prevent duplicate health checks on the same account
  if (pendingHealthChecks.has(account.id)) {
    logDebug(`[HealthCheck] Already checking account ${account.id}, skipping duplicate`);
    return;
  }

  pendingHealthChecks.add(account.id);
  logInfo(`[HealthCheck] Starting async health check for account ${account.id} (triggered by ${statusCode})`);

  // Safety timeout: force-clean pendingHealthChecks if check hangs
  const healthCheckTimeout = setTimeout(() => {
    if (pendingHealthChecks.has(account.id)) {
      pendingHealthChecks.delete(account.id);
      logError(`[HealthCheck] Account ${account.id} health check timed out (30s), force-cleaned`);
    }
  }, 30_000);

  // Use Promise + catch to avoid blocking the caller
  (async () => {
    try {
      // Step 1: Check balance to determine if token is valid & quota is exhausted
      const balance = await checkAccountBalance(account);

      // Balance check succeeded → token valid, account not banned
      // checkAccountBalance already handles setting exhausted status internally
      if (balance.usedRatio >= 1.0) {
        logInfo(`[HealthCheck] Account ${account.id} confirmed exhausted (${(balance.usedRatio * 100).toFixed(1)}% used)`);
      } else {
        // Quota normal, previous failure was transient — account stays active
        logInfo(`[HealthCheck] Account ${account.id} is healthy (${(balance.usedRatio * 100).toFixed(1)}% used), was a transient error`);
      }
    } catch (error) {
      // Balance check also failed → possibly invalid token or banned account
      if (error.statusCode === 429) {
        logInfo(`[HealthCheck] Balance check for account ${account.id} was rate-limited (429), keeping current status`);
        return;
      }
      logError(`[HealthCheck] Balance check failed for account ${account.id}`, error);

      // 401 special handling: try to refresh token (refreshAccountToken has its own lock)
      if (statusCode === 401) {
        logInfo(`[HealthCheck] Account ${account.id} token may be invalid, attempting refresh...`);
        try {
          await refreshAccountToken(account);
          logInfo(`[HealthCheck] Account ${account.id} token refreshed successfully, recovered`);
        } catch (refreshError) {
          // Refresh also failed → lock and mark as error
          const releaseAccountLock = await acquireAccountLock(account.id);
          try {
            if (accounts.includes(account) && account.status !== 'disabled') {
              account.status = 'error';
              account.error_message = `Auth failed and token refresh failed: ${refreshError.message}`;
              saveAccountsSync();
              logError(`[HealthCheck] Account ${account.id} marked as error: token refresh also failed`, refreshError);
            }
          } finally {
            releaseAccountLock();
          }
        }
        return;
      }

      // 402/403: lock and update status to prevent race with other operations
      const releaseAccountLock = await acquireAccountLock(account.id);
      try {
        // Check if account was removed or manually handled during health check
        if (!accounts.includes(account)) {
          logInfo(`[HealthCheck] Account ${account.id} was removed during check, skipping status update`);
          return;
        }
        // If admin already handled manually (e.g., disabled), don't override
        if (account.status === 'disabled') {
          logInfo(`[HealthCheck] Account ${account.id} was manually disabled, skipping status update`);
          return;
        }

        if (statusCode === 402) {
          // 402 + balance check also failed → quota issue, mark as exhausted
          account.status = 'exhausted';
          account.error_message = `Insufficient quota (402), balance check also failed: ${error.message}`;
          saveAccountsSync();
          logInfo(`[HealthCheck] Account ${account.id} marked as exhausted (402 + balance check failed)`);
        } else if (statusCode === 403) {
          // 403 + balance check also failed → likely account ban
          account.status = 'error';
          account.error_message = `Suspected ban (403), balance check also failed: ${error.message}`;
          saveAccountsSync();
          logError(`[HealthCheck] Account ${account.id} marked as error: suspected ban (403 + balance check failed)`);
        }
      } finally {
        releaseAccountLock();
      }
    } finally {
      clearTimeout(healthCheckTimeout);
      pendingHealthChecks.delete(account.id);
      logDebug(`[HealthCheck] Finished health check for account ${account.id}`);
    }
  })();
}

// ────────────────────────────────────────
// Scheduling Algorithm
// ────────────────────────────────────────

/**
 * Get count of active accounts (for retry limit)
 */
export function getActiveAccountCount() {
  return accounts.filter(a => a.status === 'active').length;
}

/**
 * Get next API key using smart scheduling
 * @param {string[]} excludeTokens - Bearer tokens to exclude (already tried in this request)
 *
 * Sorting priority:
 *   1. usage ratio descending (highest first — exhaust near-full accounts quickly)
 *   2. least-recently-used first (spread concurrent requests within similar usage band)
 * Concurrency safety:
 *   - Each request carries its own excludeTokens list, so retries within one
 *     request never pick the same account twice.
 *   - lastUsedMap ensures concurrent requests arriving at the same time are
 *     distributed across different accounts (round-robin effect).
 *   - Failure reporting triggers async health check which sets account status
 *     (exhausted/error) — visible to all subsequent getNextApiKey calls (single-threaded Node.js).
 *   - Exhausted accounts are auto-removed by asyncAccountHealthCheck and
 *     backgroundCheckBalances, keeping the account pool clean.
 *
 * Note: This function is synchronous (pure memory operations). No network IO.
 * Token refresh is handled entirely by background tasks.
 */
export function getNextApiKey(excludeTokens = []) {
  const excludeSet = new Set(excludeTokens.map(t => t.replace(/^Bearer\s+/i, '')));
  const now = Date.now();

  // 1. Filter: active, not excluded
  const active = accounts.filter(a => {
    if (a.status !== 'active') return false;
    if (excludeSet.has(a.access_token)) return false;
    return true;
  });

  if (active.length === 0) {
    throw new Error('No active accounts available');
  }

  // 2. Exclude exhausted
  const available = active.filter(a => {
    if (!a.cached_balance) return true;
    return a.cached_balance.usedRatio < 1.0;
  });
  if (available.length === 0) {
    throw new Error('All active accounts have exhausted their quota (100%)');
  }

  // 3. Must have token or refresh token
  const usable = available.filter(a => a.access_token || a.refresh_token);
  if (usable.length === 0) {
    throw new Error('No usable accounts (missing token)');
  }

  // 4. Sort: primary by usage ratio desc (exhaust near-full accounts first),
  //    secondary by least-recently-used (spread concurrent requests)
  usable.sort((a, b) => {
    const ratioA = a.cached_balance?.usedRatio ?? 0;
    const ratioB = b.cached_balance?.usedRatio ?? 0;
    // If ratios are close (within 5%), prefer least recently used
    if (Math.abs(ratioA - ratioB) < 0.05) {
      const luA = lastUsedMap.get(a.id) || 0;
      const luB = lastUsedMap.get(b.id) || 0;
      return luA - luB; // smaller timestamp = used longer ago = preferred
    }
    return ratioB - ratioA; // higher usage first — exhaust and clean up
  });

  // 5. Pick first account with a valid token (pure memory, no network IO)
  for (const account of usable) {
    if (account.type === 'apikey') {
      if (!account.access_token) continue;
      lastUsedMap.set(account.id, Date.now());
      logDebug(`Scheduled apikey account: ${account.id} (${account.label || 'no label'}, usage: ${((account.cached_balance?.usedRatio ?? 0) * 100).toFixed(1)}%)`);
      return `Bearer ${account.access_token}`;
    }

    // auth_json: skip if token expired or missing — background task will refresh it
    const tokenExpired = account.exp && account.exp < now + 5 * 60 * 1000; // 5min buffer
    const noToken = !account.access_token;

    if (tokenExpired || noToken) {
      logDebug(`Skipping account ${account.id}: token ${noToken ? 'missing' : 'expired'}, waiting for background refresh`);
      continue;
    }

    lastUsedMap.set(account.id, Date.now());
    logDebug(`Scheduled account: ${account.id} (${account.email || 'no email'}, usage: ${((account.cached_balance?.usedRatio ?? 0) * 100).toFixed(1)}%)`);
    return `Bearer ${account.access_token}`;
  }

  throw new Error('All accounts failed to provide a valid API key');
}

// ────────────────────────────────────────
// Background Tasks
// ────────────────────────────────────────

/**
 * Background: refresh tokens that are about to expire (< 1 hour remaining),
 * never refreshed, or missing access_token entirely.
 * Runs every 10 minutes. getNextApiKey skips tokens expiring within 5 minutes,
 * so we refresh well ahead to keep the pool ready.
 */
async function backgroundRefreshTokens() {
  const releaseBulkLock = await acquireBulkLock('backgroundRefreshTokens');
  try {
    const now = Date.now();
    // Refresh tokens expiring within 1 hour.
    // getNextApiKey skips tokens expiring within 5 minutes, so we refresh well ahead
    // to ensure tokens are always fresh when the scheduler picks them.
    const oneHourMs = 1 * 60 * 60 * 1000;

    const snapshot = [...accounts];
    for (const account of snapshot) {
      if (account.status !== 'active') continue;
      if (account.type === 'apikey') continue; // API Key accounts don't need refresh
      if (!account.refresh_token) continue;
      if (!accounts.includes(account)) continue;

      const tokenExpiringSoon = account.exp && (account.exp - now) < oneHourMs;
      const neverRefreshed = !account.last_refresh;
      const noToken = !account.access_token;

      if (tokenExpiringSoon || neverRefreshed || noToken) {
        try {
          await refreshAccountToken(account);
        } catch (error) {
          logError(`Background refresh failed for ${account.id}`, error);
        }
      }
    }
  } finally {
    releaseBulkLock();
  }
}

/**
 * Background: check balance for active/exhausted/error accounts
 * This allows exhausted/error accounts to auto-recover
 */
async function backgroundCheckBalances() {
  const releaseBulkLock = await acquireBulkLock('backgroundCheckBalances');
  try {
    const eligible = [...accounts].filter(a =>
      a.status !== 'disabled' && a.status !== 'checking' && a.access_token && accounts.includes(a)
    );

    await runWithConcurrency(eligible, BALANCE_CHECK_CONCURRENCY, async (account) => {
      if (!accounts.includes(account)) return;
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
    });
  } finally {
    releaseBulkLock();
  }
}

/**
 * Start background tasks
 */
export function startBackgroundTasks() {
  // Refresh tokens every 10 minutes (getNextApiKey no longer refreshes inline,
  // so background must keep tokens fresh proactively)
  const refreshTimer = setInterval(backgroundRefreshTokens, 10 * 60 * 1000);
  // Check balances every 15 minutes
  const balanceTimer = setInterval(backgroundCheckBalances, 15 * 60 * 1000);

  backgroundTimers.push(refreshTimer, balanceTimer);
  logInfo('Background tasks started (token refresh: 10min, balance check: 15min)');

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
  // Force flush to disk on stop to ensure no pending changes are lost
  if (savePending && saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    savePending = false;
    saveAccountsImmediate();
  }
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
