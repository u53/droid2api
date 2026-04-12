import { HttpsProxyAgent } from 'https-proxy-agent';
import { getProxyConfigs } from './config.js';
import { logInfo, logError, logDebug } from './logger.js';

let proxyIndex = 0;
let lastSnapshot = '';

// Sliding-window failure tracker: Map<proxyUrl, timestamp[]>
const proxyFailures = new Map();
const FAILURE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const FAILURE_THRESHOLD = 3;

function snapshotConfigs(configs) {
  try {
    return JSON.stringify(configs);
  } catch (error) {
    logDebug('Failed to snapshot proxy configs', { error: error.message });
    return '';
  }
}

/**
 * Report a proxy failure (network error or 502/503/504).
 * @param {string} proxyUrl - The proxy URL that failed
 */
export function reportProxyFailure(proxyUrl) {
  if (!proxyUrl) return;
  const now = Date.now();
  let failures = proxyFailures.get(proxyUrl);
  if (!failures) {
    failures = [];
    proxyFailures.set(proxyUrl, failures);
  }
  failures.push(now);
  logInfo(`[ProxyHealth] Recorded failure for ${proxyUrl} (${failures.length} recent failures)`);
}

/**
 * Check if a proxy is healthy (fewer than FAILURE_THRESHOLD failures in the last FAILURE_WINDOW_MS).
 * Auto-prunes old entries.
 */
function isProxyHealthy(proxyUrl) {
  const failures = proxyFailures.get(proxyUrl);
  if (!failures || failures.length === 0) return true;

  const cutoff = Date.now() - FAILURE_WINDOW_MS;
  // Prune old entries
  while (failures.length > 0 && failures[0] <= cutoff) {
    failures.shift();
  }
  if (failures.length === 0) {
    proxyFailures.delete(proxyUrl);
    return true;
  }

  return failures.length < FAILURE_THRESHOLD;
}

export function getNextProxyAgent(targetUrl) {
  const proxies = getProxyConfigs();

  if (!Array.isArray(proxies) || proxies.length === 0) {
    return null;
  }

  const currentSnapshot = snapshotConfigs(proxies);
  if (currentSnapshot !== lastSnapshot) {
    proxyIndex = 0;
    lastSnapshot = currentSnapshot;
    logInfo('Proxy configuration changed, round-robin index reset');
  }

  // First pass: skip unhealthy proxies
  for (let attempt = 0; attempt < proxies.length; attempt += 1) {
    const index = (proxyIndex + attempt) % proxies.length;
    const proxy = proxies[index];

    if (!proxy || typeof proxy.url !== 'string' || proxy.url.trim() === '') {
      logError('Invalid proxy configuration encountered', new Error(`Proxy entry at index ${index} is missing a url`));
      continue;
    }

    if (!isProxyHealthy(proxy.url)) {
      logDebug(`[ProxyHealth] Skipping unhealthy proxy ${proxy.name || proxy.url}`);
      continue;
    }

    try {
      const agent = new HttpsProxyAgent(proxy.url);
      proxyIndex = (index + 1) % proxies.length;

      const label = proxy.name || proxy.url;
      logInfo(`Using proxy ${label} for request to ${targetUrl}`);

      return { agent, proxy };
    } catch (error) {
      logError(`Failed to create proxy agent for ${proxy.url}`, error);
    }
  }

  // Fallback pass: ignore health status to prevent total blackout
  logInfo('[ProxyHealth] All proxies unhealthy, fallback pass ignoring health');
  for (let attempt = 0; attempt < proxies.length; attempt += 1) {
    const index = (proxyIndex + attempt) % proxies.length;
    const proxy = proxies[index];

    if (!proxy || typeof proxy.url !== 'string' || proxy.url.trim() === '') {
      continue;
    }

    try {
      const agent = new HttpsProxyAgent(proxy.url);
      proxyIndex = (index + 1) % proxies.length;

      const label = proxy.name || proxy.url;
      logInfo(`Using proxy ${label} (fallback) for request to ${targetUrl}`);

      return { agent, proxy };
    } catch (error) {
      logError(`Failed to create proxy agent for ${proxy.url}`, error);
    }
  }

  logError('All configured proxies failed to initialize', new Error('Proxy initialization failure'));
  return null;
}
