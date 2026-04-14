import express from 'express';
import fetch from 'node-fetch';
import { getConfig, getModelById, getEndpointByType, getSystemPrompt, getSystemAppendPrompt, getModelReasoning, getRedirectedModelId, getModelProvider } from './config.js';
import { logInfo, logDebug, logError, logRequest, logResponse, log403 } from './logger.js';
import { transformToAnthropic, getAnthropicHeaders } from './transformers/request-anthropic.js';
import { transformToOpenAI, getOpenAIHeaders } from './transformers/request-openai.js';
import { transformToCommon, getCommonHeaders } from './transformers/request-common.js';
import { transformToGoogle, getGoogleHeaders } from './transformers/request-google.js';
import { AnthropicResponseTransformer } from './transformers/response-anthropic.js';
import { OpenAIResponseTransformer } from './transformers/response-openai.js';
import { GoogleResponseTransformer } from './transformers/response-google.js';
import { getApiKey, reportApiKeyFailure } from './auth.js';
import { hasAccounts, getActiveAccountCount } from './account-manager.js';
import { getNextProxyAgent, reportProxyFailure } from './proxy-manager.js';

const router = express.Router();

// Status codes that trigger account rotation retry
// 403 not retried: usually content rejection, switching accounts won't help.
// Async health check still runs to detect account bans.
const RETRYABLE_STATUSES = new Set([401, 402, 429]);

// Status codes that indicate proxy-level failures
const PROXY_ERROR_STATUSES = new Set([502, 503, 504]);
const MAX_RETRY_ACCOUNTS = 3;

// Upstream fetch timeout: max wait for response headers (first byte).
// Does NOT limit streaming duration — only how long we wait for the upstream to start responding.
const UPSTREAM_TIMEOUT_MS = 120 * 1000; // 120 seconds

/**
 * Wrap fetch with an AbortController timeout for first-byte response.
 * Returns the fetch response; throws on timeout or network error.
 */
function fetchWithTimeout(url, options, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

/**
 * Convert a /v1/responses API result to a /v1/chat/completions-compatible format.
 * Works for non-streaming responses.
 */
function convertResponseToChatCompletion(resp) {
  if (!resp || typeof resp !== 'object') {
    throw new Error('Invalid response object');
  }

  const outputMsg = (resp.output || []).find(o => o.type === 'message');
  const textBlocks = outputMsg?.content?.filter(c => c.type === 'output_text') || [];
  const content = textBlocks.map(c => c.text).join('');

  const chatCompletion = {
    id: resp.id ? resp.id.replace(/^resp_/, 'chatcmpl-') : `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: resp.created_at || Math.floor(Date.now() / 1000),
    model: resp.model || 'unknown-model',
    choices: [
      {
        index: 0,
        message: {
          role: outputMsg?.role || 'assistant',
          content: content || ''
        },
        finish_reason: resp.status === 'completed' ? 'stop' : 'unknown'
      }
    ],
    usage: {
      prompt_tokens: resp.usage?.input_tokens ?? 0,
      completion_tokens: resp.usage?.output_tokens ?? 0,
      total_tokens: resp.usage?.total_tokens ?? 0
    }
  };

  return chatCompletion;
}

function convertGoogleResponseToChatCompletion(resp, modelId) {
  if (!resp || typeof resp !== 'object') {
    throw new Error('Invalid response object');
  }

  const candidate = resp.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  // Filter out thought parts, extract text
  const content = parts
    .filter(p => p.thought !== true)
    .map(p => p.text || '')
    .join('');

  const finishReasonMap = {
    'STOP': 'stop',
    'MAX_TOKENS': 'length',
    'SAFETY': 'content_filter',
    'RECITATION': 'content_filter'
  };

  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelId || resp.modelVersion || 'unknown-model',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: content || ''
        },
        finish_reason: finishReasonMap[candidate?.finishReason] || 'stop'
      }
    ],
    usage: {
      prompt_tokens: resp.usageMetadata?.promptTokenCount ?? 0,
      completion_tokens: resp.usageMetadata?.candidatesTokenCount ?? 0,
      total_tokens: resp.usageMetadata?.totalTokenCount ?? 0
    }
  };
}

router.get('/v1/models', (req, res) => {
  logInfo('GET /v1/models');
  
  try {
    const config = getConfig();
    const models = config.models.map(model => ({
      id: model.id,
      object: 'model',
      created: Date.now(),
      owned_by: model.type,
      permission: [],
      root: model.id,
      parent: null
    }));

    const response = {
      object: 'list',
      data: models
    };

    logResponse(200, null, response);
    res.json(response);
  } catch (error) {
    logError('Error in GET /v1/models', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Standard OpenAI chat completion handler (with format conversion)
async function handleChatCompletions(req, res) {
  logInfo('POST /v1/chat/completions');

  try {
    const openaiRequest = req.body;
    const modelId = getRedirectedModelId(openaiRequest.model);

    if (!modelId) {
      return res.status(400).json({ error: 'model is required' });
    }

    const model = getModelById(modelId);
    if (!model) {
      return res.status(404).json({ error: `Model ${modelId} not found` });
    }

    logInfo(`Model: ${modelId}`);

    const endpoint = getEndpointByType(model.type);
    if (!endpoint) {
      return res.status(500).json({ error: `Endpoint type ${model.type} not found` });
    }

    logInfo(`Routing to ${model.type} endpoint: ${endpoint.base_url}`);

    const clientHeaders = req.headers;
    const requestWithRedirectedModel = { ...openaiRequest, model: modelId };
    const provider = getModelProvider(modelId);
    const useRetry = hasAccounts();

    // Transform request (only needs to be done once)
    let transformedRequest;
    if (model.type === 'anthropic') {
      transformedRequest = transformToAnthropic(requestWithRedirectedModel);
    } else if (model.type === 'openai') {
      transformedRequest = transformToOpenAI(requestWithRedirectedModel);
    } else if (model.type === 'google') {
      transformedRequest = transformToGoogle(requestWithRedirectedModel);
    } else if (model.type === 'common') {
      transformedRequest = transformToCommon(requestWithRedirectedModel);
    } else {
      return res.status(500).json({ error: `Unknown endpoint type: ${model.type}` });
    }

    // Retry loop: try different accounts on retryable errors
    const triedTokens = [];
    let response;
    let lastErrorStatus = 500;
    let lastErrorText = '';

    const maxAttempts = useRetry ? Math.min(getActiveAccountCount(), MAX_RETRY_ACCOUNTS) : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Abort retry if client already disconnected
      if (req.socket.destroyed) {
        logInfo(`[Retry] Client disconnected before attempt ${attempt + 1}, aborting`);
        return;
      }

      let authHeader;
      try {
        authHeader = await getApiKey(req.headers.authorization, triedTokens);
      } catch (error) {
        logError('Failed to get API key', error);
        if (attempt > 0) break; // had retries, break to return last error
        return res.status(500).json({ error: 'API key not available', message: error.message });
      }

      let headers;
      if (model.type === 'anthropic') {
        headers = getAnthropicHeaders(authHeader, clientHeaders, openaiRequest.stream === true, modelId, provider);
      } else if (model.type === 'openai') {
        headers = getOpenAIHeaders(authHeader, clientHeaders, provider);
      } else if (model.type === 'google') {
        headers = getGoogleHeaders(authHeader, clientHeaders, provider);
      } else {
        headers = getCommonHeaders(authHeader, clientHeaders, provider);
      }

      logRequest('POST', endpoint.base_url, headers, transformedRequest);

      const proxyAgentInfo = getNextProxyAgent(endpoint.base_url);
      const fetchOptions = { method: 'POST', headers, body: JSON.stringify(transformedRequest) };
      if (proxyAgentInfo?.agent) fetchOptions.agent = proxyAgentInfo.agent;

      try {
        response = await fetchWithTimeout(endpoint.base_url, fetchOptions);
      } catch (networkError) {
        if (proxyAgentInfo?.proxy?.url) reportProxyFailure(proxyAgentInfo.proxy.url);
        throw networkError;
      }
      logDebug(`Response status: ${response.status}`);

      if (PROXY_ERROR_STATUSES.has(response.status) && proxyAgentInfo?.proxy?.url) {
        reportProxyFailure(proxyAgentInfo.proxy.url);
      }

      if (response.ok) break; // Success

      // Check if retryable
      if (useRetry && RETRYABLE_STATUSES.has(response.status) && attempt < maxAttempts - 1) {
        lastErrorText = await response.text();
        lastErrorStatus = response.status;
        reportApiKeyFailure(authHeader, response.status, lastErrorText);
        triedTokens.push(authHeader);
        logInfo(`[Retry] ${response.status} on attempt ${attempt + 1}, switching account...`);
        continue;
      }

      // Non-retryable error or last attempt
      const errorText = lastErrorText || await response.text();
      if (useRetry && response.status === 403) {
        reportApiKeyFailure(authHeader, response.status, errorText);
      }
      if (response.status === 403) {
        log403('POST', endpoint.base_url, headers, transformedRequest, errorText);
      }
      logError(`Endpoint error: ${response.status}`, new Error(errorText));
      return res.status(response.status).json({ error: `Endpoint returned ${response.status}`, details: errorText });
    }

    // If we exhausted retries without a successful response
    if (!response || !response.ok) {
      return res.status(lastErrorStatus).json({ error: `Endpoint returned ${lastErrorStatus}`, details: lastErrorText });
    }

    const isStreaming = openaiRequest.stream === true;

    if (isStreaming) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      // Common type: forward directly without transformer
      if (model.type === 'common') {
        try {
          for await (const chunk of response.body) {
            if (req.socket.destroyed) {
              logInfo('Client disconnected during stream, destroying upstream');
              response.body.destroy();
              return;
            }
            res.write(chunk);
          }
          res.end();
          logInfo('Stream forwarded (common type)');
        } catch (streamError) {
          logError('Stream error', streamError);
          if (!res.writableEnded) res.end();
        }
      } else {
        // Anthropic, OpenAI, and Google types use transformer
        let transformer;
        if (model.type === 'anthropic') {
          transformer = new AnthropicResponseTransformer(modelId, `chatcmpl-${Date.now()}`);
        } else if (model.type === 'openai') {
          transformer = new OpenAIResponseTransformer(modelId, `chatcmpl-${Date.now()}`);
        } else if (model.type === 'google') {
          transformer = new GoogleResponseTransformer(modelId, `chatcmpl-${Date.now()}`);
        }

        try {
          for await (const chunk of transformer.transformStream(response.body)) {
            if (req.socket.destroyed) {
              logInfo('Client disconnected during stream, destroying upstream');
              response.body.destroy();
              return;
            }
            res.write(chunk);
          }
          res.end();
          logInfo('Stream completed');
        } catch (streamError) {
          logError('Stream error', streamError);
          if (!res.writableEnded) res.end();
        }
      }
    } else {
      const data = await response.json();
      if (model.type === 'openai') {
        try {
          const converted = convertResponseToChatCompletion(data);
          logResponse(200, null, converted);
          res.json(converted);
        } catch (e) {
          logResponse(200, null, data);
          res.json(data);
        }
      } else if (model.type === 'google') {
        try {
          const converted = convertGoogleResponseToChatCompletion(data, modelId);
          logResponse(200, null, converted);
          res.json(converted);
        } catch (e) {
          logResponse(200, null, data);
          res.json(data);
        }
      } else {
        // anthropic/common: forward directly
        logResponse(200, null, data);
        res.json(data);
      }
    }

  } catch (error) {
    logError('Error in /v1/chat/completions', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
}

// Direct forward OpenAI request (no format conversion)
async function handleDirectResponses(req, res) {
  logInfo('POST /v1/responses');

  try {
    const openaiRequest = req.body;
    const modelId = getRedirectedModelId(openaiRequest.model);

    if (!modelId) {
      return res.status(400).json({ error: 'model is required' });
    }

    const model = getModelById(modelId);
    if (!model) {
      return res.status(404).json({ error: `Model ${modelId} not found` });
    }

    logInfo(`Model: ${modelId}`);

    // Only allow openai endpoint type
    if (model.type !== 'openai') {
      return res.status(400).json({
        error: 'Invalid endpoint type',
        message: `/v1/responses only supports openai endpoint type, model ${modelId} is ${model.type} type`
      });
    }

    const endpoint = getEndpointByType(model.type);
    if (!endpoint) {
      return res.status(500).json({ error: `Endpoint type ${model.type} not found` });
    }

    logInfo(`Direct forwarding to ${model.type} endpoint: ${endpoint.base_url}`);

    const clientHeaders = req.headers;
    const clientAuth = req.headers['x-api-key'] ? `Bearer ${req.headers['x-api-key']}` : req.headers.authorization;
    const provider = getModelProvider(modelId);
    const useRetry = hasAccounts();

    // Build modified request (once)
    const systemPrompt = getSystemPrompt();
    const modifiedRequest = { ...openaiRequest, model: modelId };
    if (systemPrompt) {
      modifiedRequest.instructions = modifiedRequest.instructions
        ? systemPrompt + modifiedRequest.instructions
        : systemPrompt;
    }
    const reasoningLevel = getModelReasoning(modelId);
    if (reasoningLevel === 'auto') { /* keep */ }
    else if (reasoningLevel && ['low', 'medium', 'high', 'xhigh'].includes(reasoningLevel)) {
      modifiedRequest.reasoning = { effort: reasoningLevel, summary: 'auto' };
    } else { delete modifiedRequest.reasoning; }

    // Retry loop
    const triedTokens = [];
    let response;
    let lastErrorStatus = 500;
    let lastErrorText = '';

    const maxAttempts = useRetry ? Math.min(getActiveAccountCount(), MAX_RETRY_ACCOUNTS) : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Abort retry if client already disconnected
      if (req.socket.destroyed) {
        logInfo(`[Retry] Client disconnected before attempt ${attempt + 1}, aborting`);
        return;
      }

      let authHeader;
      try {
        authHeader = await getApiKey(clientAuth, triedTokens);
      } catch (error) {
        logError('Failed to get API key', error);
        if (attempt > 0) break;
        return res.status(500).json({ error: 'API key not available', message: error.message });
      }

      const headers = getOpenAIHeaders(authHeader, clientHeaders, provider);
      logRequest('POST', endpoint.base_url, headers, modifiedRequest);

      const proxyAgentInfo = getNextProxyAgent(endpoint.base_url);
      const fetchOptions = { method: 'POST', headers, body: JSON.stringify(modifiedRequest) };
      if (proxyAgentInfo?.agent) fetchOptions.agent = proxyAgentInfo.agent;

      try {
        response = await fetchWithTimeout(endpoint.base_url, fetchOptions);
      } catch (networkError) {
        if (proxyAgentInfo?.proxy?.url) reportProxyFailure(proxyAgentInfo.proxy.url);
        throw networkError;
      }
      logDebug(`Response status: ${response.status}`);

      if (PROXY_ERROR_STATUSES.has(response.status) && proxyAgentInfo?.proxy?.url) {
        reportProxyFailure(proxyAgentInfo.proxy.url);
      }

      if (response.ok) break;

      if (useRetry && RETRYABLE_STATUSES.has(response.status) && attempt < maxAttempts - 1) {
        lastErrorText = await response.text();
        lastErrorStatus = response.status;
        reportApiKeyFailure(authHeader, response.status, lastErrorText);
        triedTokens.push(authHeader);
        logInfo(`[Retry] ${response.status} on attempt ${attempt + 1}, switching account...`);
        continue;
      }

      const errorText = lastErrorText || await response.text();
      if (useRetry && response.status === 403) {
        reportApiKeyFailure(authHeader, response.status, errorText);
      }
      if (response.status === 403) {
        log403('POST', endpoint.base_url, headers, modifiedRequest, errorText);
      }
      logError(`Endpoint error: ${response.status}`, new Error(errorText));
      return res.status(response.status).json({ error: `Endpoint returned ${response.status}`, details: errorText });
    }

    if (!response || !response.ok) {
      return res.status(lastErrorStatus).json({ error: `Endpoint returned ${lastErrorStatus}`, details: lastErrorText });
    }

    const isStreaming = openaiRequest.stream === true;

    if (isStreaming) {
      // Forward streaming response directly
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      try {
        // Forward raw response stream to client, abort if client disconnects
        for await (const chunk of response.body) {
          if (req.socket.destroyed) {
            logInfo('Client disconnected during stream, destroying upstream');
            response.body.destroy();
            return;
          }
          res.write(chunk);
        }
        res.end();
        logDebug('Stream forwarded successfully');
      } catch (streamError) {
        logError('Stream error', streamError);
        if (!res.writableEnded) res.end();
      }
    } else {
      // Forward non-streaming response directly
      const data = await response.json();
      logResponse(200, null, data);
      res.json(data);
    }

  } catch (error) {
    logError('Error in /v1/responses', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
}

function sanitizeAnthropicText(text) {
  if (typeof text !== 'string' || !text) return text;
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, '')
    .replace(
      /Contents of [^\n]*[\\/]\.claude(?:[\\/][^\n]+?\.md) \((?:user's )?private global instructions for all projects\):?/g,
      'User global instructions:'
    )
    .trim();
}

function sanitizeAnthropicMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map(msg => {
    if (typeof msg.content === 'string') {
      return { ...msg, content: sanitizeAnthropicText(msg.content) };
    }
    if (Array.isArray(msg.content)) {
      return {
        ...msg,
        content: msg.content
          .map(part => (
            part && part.type === 'text' && typeof part.text === 'string'
              ? { ...part, text: sanitizeAnthropicText(part.text) }
              : part
          ))
          .filter(part => !(part && part.type === 'text' && typeof part.text === 'string' && part.text.trim() === ''))
      };
    }
    return msg;
  });
}

// Direct forward Anthropic request (no format conversion)
async function handleDirectMessages(req, res) {
  logInfo('POST /v1/messages');

  try {
    const anthropicRequest = req.body;
    const modelId = getRedirectedModelId(anthropicRequest.model);

    if (!modelId) {
      return res.status(400).json({ error: 'model is required' });
    }

    const model = getModelById(modelId);
    if (!model) {
      return res.status(404).json({ error: `Model ${modelId} not found` });
    }

    logInfo(`Model: ${modelId}`);

    // Only allow anthropic endpoint type
    if (model.type !== 'anthropic') {
      return res.status(400).json({
        error: 'Invalid endpoint type',
        message: `/v1/messages only supports anthropic endpoint type, model ${modelId} is ${model.type} type`
      });
    }

    const endpoint = getEndpointByType(model.type);
    if (!endpoint) {
      return res.status(500).json({ error: `Endpoint type ${model.type} not found` });
    }

    logInfo(`Direct forwarding to ${model.type} endpoint: ${endpoint.base_url}`);

    const clientHeaders = req.headers;
    const clientAuth = req.headers['x-api-key'] ? `Bearer ${req.headers['x-api-key']}` : req.headers.authorization;
    const provider = getModelProvider(modelId);
    const isStreaming = anthropicRequest.stream === true;
    const useRetry = hasAccounts();

    // Build modified request (once) — strip fields that may cause upstream 403
    const systemPrompt = getSystemPrompt();
    const systemAppendPrompt = getSystemAppendPrompt();
    const {
      output_config: _outputConfig,
      context_management: _ctxMgmt,
      metadata: _metadata,
      ...cleanRequest
    } = anthropicRequest;
    const modifiedRequest = { ...cleanRequest, model: modelId };
    modifiedRequest.messages = sanitizeAnthropicMessages(modifiedRequest.messages);
    if (systemPrompt || systemAppendPrompt) {
      modifiedRequest.system = [];
      if (systemPrompt) {
        modifiedRequest.system.push({ type: 'text', text: systemPrompt });
      }
      if (systemAppendPrompt) {
        modifiedRequest.system.push({ type: 'text', text: systemAppendPrompt });
      }
    } else {
      delete modifiedRequest.system;
    }

    const reasoningLevel = getModelReasoning(modelId);
    if (reasoningLevel === 'auto') { /* keep */ }
    else if (reasoningLevel && ['low', 'medium', 'high', 'xhigh'].includes(reasoningLevel)) {
      const budgetTokens = { low: 4096, medium: 12288, high: 24576, xhigh: 40960 };
      modifiedRequest.thinking = { type: 'enabled', budget_tokens: budgetTokens[reasoningLevel] };
    } else { delete modifiedRequest.thinking; }

    // Retry loop
    const triedTokens = [];
    let response;
    let lastErrorStatus = 500;
    let lastErrorText = '';

    const maxAttempts = useRetry ? Math.min(getActiveAccountCount(), MAX_RETRY_ACCOUNTS) : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Abort retry if client already disconnected (avoid wasting account quota)
      if (req.socket.destroyed) {
        logInfo(`[Retry] Client disconnected before attempt ${attempt + 1}, aborting`);
        return;
      }

      let authHeader;
      try {
        authHeader = await getApiKey(clientAuth, triedTokens);
      } catch (error) {
        logError('Failed to get API key', error);
        if (attempt > 0) break;
        return res.status(500).json({ error: 'API key not available', message: error.message });
      }

      const headers = getAnthropicHeaders(authHeader, clientHeaders, isStreaming, modelId, provider);
      logRequest('POST', endpoint.base_url, headers, modifiedRequest);

      const proxyAgentInfo = getNextProxyAgent(endpoint.base_url);
      const fetchOptions = { method: 'POST', headers, body: JSON.stringify(modifiedRequest) };
      if (proxyAgentInfo?.agent) fetchOptions.agent = proxyAgentInfo.agent;

      try {
        response = await fetchWithTimeout(endpoint.base_url, fetchOptions);
      } catch (networkError) {
        if (proxyAgentInfo?.proxy?.url) reportProxyFailure(proxyAgentInfo.proxy.url);
        throw networkError;
      }
      logDebug(`Response status: ${response.status}`);

      if (PROXY_ERROR_STATUSES.has(response.status) && proxyAgentInfo?.proxy?.url) {
        reportProxyFailure(proxyAgentInfo.proxy.url);
      }

      if (response.ok) break;

      if (useRetry && RETRYABLE_STATUSES.has(response.status) && attempt < maxAttempts - 1) {
        lastErrorText = await response.text();
        lastErrorStatus = response.status;
        reportApiKeyFailure(authHeader, response.status, lastErrorText);
        triedTokens.push(authHeader);
        logInfo(`[Retry] ${response.status} on attempt ${attempt + 1}, switching account...`);
        continue;
      }

      const errorText = lastErrorText || await response.text();
      if (useRetry && response.status === 403) {
        reportApiKeyFailure(authHeader, response.status, errorText);
      }
      if (response.status === 403) {
        log403('POST', endpoint.base_url, headers, modifiedRequest, errorText);
      }
      logError(`Endpoint error: ${response.status}`, new Error(errorText));
      return res.status(response.status).json({ error: `Endpoint returned ${response.status}`, details: errorText });
    }

    if (!response || !response.ok) {
      return res.status(lastErrorStatus).json({ error: `Endpoint returned ${lastErrorStatus}`, details: lastErrorText });
    }

    if (isStreaming) {
      // Forward streaming response directly
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      try {
        // Forward raw response stream to client, abort if client disconnects
        for await (const chunk of response.body) {
          if (req.socket.destroyed) {
            logInfo('Client disconnected during stream, destroying upstream');
            response.body.destroy();
            return;
          }
          res.write(chunk);
        }
        res.end();
        logDebug('Stream forwarded successfully');
      } catch (streamError) {
        logError('Stream error', streamError);
        if (!res.writableEnded) res.end();
      }
    } else {
      // Forward non-streaming response directly
      const data = await response.json();
      logResponse(200, null, data);
      res.json(data);
    }

  } catch (error) {
    logError('Error in /v1/messages', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
}

// Handle Anthropic count_tokens request
async function handleCountTokens(req, res) {
  logInfo('POST /v1/messages/count_tokens');

  try {
    const anthropicRequest = req.body;
    const modelId = getRedirectedModelId(anthropicRequest.model);

    if (!modelId) {
      return res.status(400).json({ error: 'model is required' });
    }

    const model = getModelById(modelId);
    if (!model) {
      return res.status(404).json({ error: `Model ${modelId} not found` });
    }

    logInfo(`Model: ${modelId}`);

    // Only allow anthropic endpoint type
    if (model.type !== 'anthropic') {
      return res.status(400).json({
        error: 'Invalid endpoint type',
        message: `/v1/messages/count_tokens only supports anthropic endpoint type, model ${modelId} is ${model.type} type`
      });
    }

    const endpoint = getEndpointByType('anthropic');
    if (!endpoint) {
      return res.status(500).json({ error: 'Endpoint type anthropic not found' });
    }

    const clientHeaders = req.headers;
    const clientAuth = req.headers['x-api-key'] ? `Bearer ${req.headers['x-api-key']}` : req.headers.authorization;
    const provider = getModelProvider(modelId);
    const countTokensUrl = endpoint.base_url.replace('/v1/messages', '/v1/messages/count_tokens');
    const useRetry = hasAccounts();

    const systemPrompt = getSystemPrompt();
    const systemAppendPrompt = getSystemAppendPrompt();
    const modifiedRequest = { ...anthropicRequest, model: modelId };
    if (systemPrompt || systemAppendPrompt) {
      modifiedRequest.system = [];
      if (systemPrompt) {
        modifiedRequest.system.push({ type: 'text', text: systemPrompt });
      }
      if (systemAppendPrompt) {
        modifiedRequest.system.push({ type: 'text', text: systemAppendPrompt });
      }
    } else {
      delete modifiedRequest.system;
    }

    logInfo(`Forwarding to count_tokens endpoint: ${countTokensUrl}`);

    // Retry loop
    const triedTokens = [];
    let response;
    let lastErrorStatus = 500;
    let lastErrorText = '';

    const maxAttempts = useRetry ? Math.min(getActiveAccountCount(), MAX_RETRY_ACCOUNTS) : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Abort retry if client already disconnected
      if (req.socket.destroyed) {
        logInfo(`[Retry] Client disconnected before attempt ${attempt + 1}, aborting`);
        return;
      }

      let authHeader;
      try {
        authHeader = await getApiKey(clientAuth, triedTokens);
      } catch (error) {
        logError('Failed to get API key', error);
        if (attempt > 0) break;
        return res.status(500).json({ error: 'API key not available', message: error.message });
      }

      const headers = getAnthropicHeaders(authHeader, clientHeaders, false, modelId, provider);
      logRequest('POST', countTokensUrl, headers, modifiedRequest);

      const proxyAgentInfo = getNextProxyAgent(countTokensUrl);
      const fetchOptions = { method: 'POST', headers, body: JSON.stringify(modifiedRequest) };
      if (proxyAgentInfo?.agent) fetchOptions.agent = proxyAgentInfo.agent;

      try {
        response = await fetchWithTimeout(countTokensUrl, fetchOptions);
      } catch (networkError) {
        if (proxyAgentInfo?.proxy?.url) reportProxyFailure(proxyAgentInfo.proxy.url);
        throw networkError;
      }
      logDebug(`Response status: ${response.status}`);

      if (PROXY_ERROR_STATUSES.has(response.status) && proxyAgentInfo?.proxy?.url) {
        reportProxyFailure(proxyAgentInfo.proxy.url);
      }

      if (response.ok) break;

      if (useRetry && RETRYABLE_STATUSES.has(response.status) && attempt < maxAttempts - 1) {
        lastErrorText = await response.text();
        lastErrorStatus = response.status;
        reportApiKeyFailure(authHeader, response.status, lastErrorText);
        triedTokens.push(authHeader);
        logInfo(`[Retry] ${response.status} on attempt ${attempt + 1}, switching account...`);
        continue;
      }

      const errorText = lastErrorText || await response.text();
      if (response.status === 403) {
        log403('POST', countTokensUrl, headers, modifiedRequest, errorText);
      }
      logError(`Count tokens error: ${response.status}`, new Error(errorText));
      return res.status(response.status).json({ error: `Endpoint returned ${response.status}`, details: errorText });
    }

    if (!response || !response.ok) {
      return res.status(lastErrorStatus).json({ error: `Endpoint returned ${lastErrorStatus}`, details: lastErrorText });
    }

    const data = await response.json();
    logResponse(200, null, data);
    res.json(data);

  } catch (error) {
    logError('Error in /v1/messages/count_tokens', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
}

// Direct forward Google request (no format conversion)
async function handleDirectGenerate(req, res) {
  logInfo('POST /v1/generate');

  try {
    const googleRequest = req.body;
    const modelId = getRedirectedModelId(googleRequest.model);

    if (!modelId) {
      return res.status(400).json({ error: 'model is required' });
    }

    const model = getModelById(modelId);
    if (!model) {
      return res.status(404).json({ error: `Model ${modelId} not found` });
    }

    logInfo(`Model: ${modelId}`);

    // Only allow google endpoint type
    if (model.type !== 'google') {
      return res.status(400).json({
        error: 'Invalid endpoint type',
        message: `/v1/generate only supports google endpoint type, model ${modelId} is ${model.type} type`
      });
    }

    const endpoint = getEndpointByType(model.type);
    if (!endpoint) {
      return res.status(500).json({ error: `Endpoint type ${model.type} not found` });
    }

    logInfo(`Direct forwarding to ${model.type} endpoint: ${endpoint.base_url}`);

    const clientHeaders = req.headers;
    const provider = getModelProvider(modelId);
    const useRetry = hasAccounts();

    // Build modified request (once)
    const systemPrompt = getSystemPrompt();
    const modifiedRequest = { ...googleRequest, model: modelId };
    if (systemPrompt) {
      if (modifiedRequest.systemInstruction?.parts && Array.isArray(modifiedRequest.systemInstruction.parts)) {
        modifiedRequest.systemInstruction = {
          ...modifiedRequest.systemInstruction,
          parts: [{ text: systemPrompt }, ...modifiedRequest.systemInstruction.parts]
        };
      } else {
        modifiedRequest.systemInstruction = { parts: [{ text: systemPrompt }] };
      }
    }

    const reasoningLevel = getModelReasoning(modelId);
    if (reasoningLevel === 'auto') { /* keep */ }
    else if (reasoningLevel && ['low', 'medium', 'high'].includes(reasoningLevel)) {
      const levelMap = { low: 'LOW', medium: 'MEDIUM', high: 'HIGH' };
      if (!modifiedRequest.generationConfig) modifiedRequest.generationConfig = {};
      if (!modifiedRequest.generationConfig.thinkingConfig) modifiedRequest.generationConfig.thinkingConfig = {};
      modifiedRequest.generationConfig.thinkingConfig.thinkingLevel = levelMap[reasoningLevel];
    } else {
      if (modifiedRequest.generationConfig) delete modifiedRequest.generationConfig.thinkingConfig;
    }

    // Retry loop
    const triedTokens = [];
    let response;
    let lastErrorStatus = 500;
    let lastErrorText = '';

    const maxAttempts = useRetry ? Math.min(getActiveAccountCount(), MAX_RETRY_ACCOUNTS) : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Abort retry if client already disconnected
      if (req.socket.destroyed) {
        logInfo(`[Retry] Client disconnected before attempt ${attempt + 1}, aborting`);
        return;
      }

      let authHeader;
      try {
        authHeader = await getApiKey(req.headers.authorization, triedTokens);
      } catch (error) {
        logError('Failed to get API key', error);
        if (attempt > 0) break;
        return res.status(500).json({ error: 'API key not available', message: error.message });
      }

      const headers = getGoogleHeaders(authHeader, clientHeaders, provider);
      logRequest('POST', endpoint.base_url, headers, modifiedRequest);

      const proxyAgentInfo = getNextProxyAgent(endpoint.base_url);
      const fetchOptions = { method: 'POST', headers, body: JSON.stringify(modifiedRequest) };
      if (proxyAgentInfo?.agent) fetchOptions.agent = proxyAgentInfo.agent;

      try {
        response = await fetchWithTimeout(endpoint.base_url, fetchOptions);
      } catch (networkError) {
        if (proxyAgentInfo?.proxy?.url) reportProxyFailure(proxyAgentInfo.proxy.url);
        throw networkError;
      }
      logDebug(`Response status: ${response.status}`);

      if (PROXY_ERROR_STATUSES.has(response.status) && proxyAgentInfo?.proxy?.url) {
        reportProxyFailure(proxyAgentInfo.proxy.url);
      }

      if (response.ok) break;

      if (useRetry && RETRYABLE_STATUSES.has(response.status) && attempt < maxAttempts - 1) {
        lastErrorText = await response.text();
        lastErrorStatus = response.status;
        reportApiKeyFailure(authHeader, response.status, lastErrorText);
        triedTokens.push(authHeader);
        logInfo(`[Retry] ${response.status} on attempt ${attempt + 1}, switching account...`);
        continue;
      }

      const errorText = lastErrorText || await response.text();
      if (useRetry && response.status === 403) {
        reportApiKeyFailure(authHeader, response.status, errorText);
      }
      if (response.status === 403) {
        log403('POST', endpoint.base_url, headers, modifiedRequest, errorText);
      }
      logError(`Endpoint error: ${response.status}`, new Error(errorText));
      return res.status(response.status).json({ error: `Endpoint returned ${response.status}`, details: errorText });
    }

    if (!response || !response.ok) {
      return res.status(lastErrorStatus).json({ error: `Endpoint returned ${lastErrorStatus}`, details: lastErrorText });
    }

    const isStreaming = googleRequest.stream === true;

    if (isStreaming) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      try {
        for await (const chunk of response.body) {
          if (req.socket.destroyed) {
            logInfo('Client disconnected during stream, destroying upstream');
            response.body.destroy();
            return;
          }
          res.write(chunk);
        }
        res.end();
        logDebug('Stream forwarded successfully');
      } catch (streamError) {
        logError('Stream error', streamError);
        if (!res.writableEnded) res.end();
      }
    } else {
      const data = await response.json();
      logResponse(200, null, data);
      res.json(data);
    }

  } catch (error) {
    logError('Error in /v1/generate', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
}

// Register routes
router.post('/v1/chat/completions', handleChatCompletions);
router.post('/v1/responses', handleDirectResponses);
router.post('/v1/messages', handleDirectMessages);
router.post('/v1/messages/count_tokens', handleCountTokens);
router.post('/v1/generate', handleDirectGenerate);

export default router;
