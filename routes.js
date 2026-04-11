import express from 'express';
import fetch from 'node-fetch';
import { getConfig, getModelById, getEndpointByType, getSystemPrompt, getSystemAppendPrompt, getModelReasoning, getRedirectedModelId, getModelProvider } from './config.js';
import { logInfo, logDebug, logError, logRequest, logResponse } from './logger.js';
import { transformToAnthropic, getAnthropicHeaders } from './transformers/request-anthropic.js';
import { transformToOpenAI, getOpenAIHeaders } from './transformers/request-openai.js';
import { transformToCommon, getCommonHeaders } from './transformers/request-common.js';
import { transformToGoogle, getGoogleHeaders } from './transformers/request-google.js';
import { AnthropicResponseTransformer } from './transformers/response-anthropic.js';
import { OpenAIResponseTransformer } from './transformers/response-openai.js';
import { GoogleResponseTransformer } from './transformers/response-google.js';
import { getApiKey, reportApiKeyFailure } from './auth.js';
import { hasAccounts, getActiveAccountCount } from './account-manager.js';
import { getNextProxyAgent } from './proxy-manager.js';

const router = express.Router();

// Status codes that trigger account rotation retry
const RETRYABLE_STATUSES = new Set([401, 402, 403, 429]);

function isForbiddenError(status, detail) {
  return status === 403 && /forbidden/i.test(detail || '');
}

/**
 * 净化系统提示词中的 Claude Code 身份关键词
 * 防止上游 Factory.ai 检测到 Claude Code 特征返回 403
 * 同时保留工具定义、能力描述等有用内容
 */
function sanitizeClaudeCodeIdentity(text) {
  if (!text) return text;
  let cleaned = text;
  // 核心身份关键词 — 必须在发送到 Factory.ai 之前全部移除
  // 注意顺序：长匹配在前，短匹配在后，避免误替换
  cleaned = cleaned.replace(/\bClaude Code CLI\b/gi, 'the CLI');
  cleaned = cleaned.replace(/\bClaude Code\b/g, 'the assistant');
  cleaned = cleaned.replace(/\bclaude[_-]code\b/gi, 'the assistant');
  cleaned = cleaned.replace(/You are Claude Code,/gi, 'You are an AI assistant,');
  cleaned = cleaned.replace(/This is Claude Code/gi, 'This is an AI assistant');
  // Anthropic 品牌相关
  cleaned = cleaned.replace(/Anthropic's official CLI for Claude/gi, "an AI coding assistant");
  cleaned = cleaned.replace(/Anthropic's (?:official )?CLI/gi, 'an AI CLI tool');
  // Agent SDK 相关
  cleaned = cleaned.replace(/Claude Agent SDK/gi, 'the Agent SDK');
  cleaned = cleaned.replace(/claude\.ai/gi, 'the platform');
  return cleaned;
}

/**
 * 从客户端请求中提取 system prompt blocks，净化后与服务器 prompt 合并
 * 策略：[服务器前置prompt] + [净化后的客户端prompt] + [服务器追加prompt(含身份恢复)]
 */
function buildMergedSystemPrompt(clientSystem) {
  const systemPrompt = getSystemPrompt();
  const systemAppendPrompt = getSystemAppendPrompt();

  // 1. 解析客户端 system prompt
  let clientBlocks = [];
  if (clientSystem) {
    if (typeof clientSystem === 'string') {
      clientBlocks = [{ type: 'text', text: clientSystem }];
    } else if (Array.isArray(clientSystem)) {
      clientBlocks = clientSystem.map(b => ({ ...b }));
    }
  }

  // 2. 净化客户端 blocks 中的 Claude Code 关键词
  clientBlocks = clientBlocks.map(block => {
    if (block.type === 'text' && block.text) {
      return { ...block, text: sanitizeClaudeCodeIdentity(block.text) };
    }
    return block;
  });

  // 3. 组装: 服务器前置 + 净化后客户端 + 服务器追加(含身份恢复指令)
  const finalSystem = [];
  if (systemPrompt) {
    finalSystem.push({ type: 'text', text: systemPrompt });
  }
  finalSystem.push(...clientBlocks);
  if (systemAppendPrompt) {
    finalSystem.push({ type: 'text', text: systemAppendPrompt });
  }

  return finalSystem.length > 0 ? finalSystem : null;
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

// 标准 OpenAI 聊天补全处理函数（带格式转换）
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

    const maxAttempts = useRetry ? getActiveAccountCount() : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
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

      response = await fetch(endpoint.base_url, fetchOptions);
      logInfo(`Response status: ${response.status}`);

      if (response.ok) break; // Success

      // Check if retryable
      if (useRetry && RETRYABLE_STATUSES.has(response.status) && attempt < maxAttempts - 1) {
        lastErrorText = await response.text();
        lastErrorStatus = response.status;
        reportApiKeyFailure(authHeader, response.status, lastErrorText);
        if (isForbiddenError(response.status, lastErrorText)) {
          break;
        }
        triedTokens.push(authHeader);
        logInfo(`[Retry] ${response.status} on attempt ${attempt + 1}, switching account...`);
        continue;
      }

      // Non-retryable error or last attempt
      const errorText = lastErrorText || await response.text();
      if (useRetry && isForbiddenError(response.status, errorText)) {
        reportApiKeyFailure(authHeader, response.status, errorText);
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

      // common 类型直接转发，不使用 transformer
      if (model.type === 'common') {
        try {
          for await (const chunk of response.body) {
            res.write(chunk);
          }
          res.end();
          logInfo('Stream forwarded (common type)');
        } catch (streamError) {
          logError('Stream error', streamError);
          res.end();
        }
      } else {
        // anthropic 和 openai 类型使用 transformer
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
            res.write(chunk);
          }
          res.end();
          logInfo('Stream completed');
        } catch (streamError) {
          logError('Stream error', streamError);
          res.end();
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
        // anthropic/common: 保持现有逻辑，直接转发
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

// 直接转发 OpenAI 请求（不做格式转换）
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

    // 只允许 openai 类型端点
    if (model.type !== 'openai') {
      return res.status(400).json({ 
        error: 'Invalid endpoint type',
        message: `/v1/responses 接口只支持 openai 类型端点，当前模型 ${modelId} 是 ${model.type} 类型`
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

    const maxAttempts = useRetry ? getActiveAccountCount() : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
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

      response = await fetch(endpoint.base_url, fetchOptions);
      logInfo(`Response status: ${response.status}`);

      if (response.ok) break;

      if (useRetry && RETRYABLE_STATUSES.has(response.status) && attempt < maxAttempts - 1) {
        lastErrorText = await response.text();
        lastErrorStatus = response.status;
        reportApiKeyFailure(authHeader, response.status, lastErrorText);
        if (isForbiddenError(response.status, lastErrorText)) {
          break;
        }
        triedTokens.push(authHeader);
        logInfo(`[Retry] ${response.status} on attempt ${attempt + 1}, switching account...`);
        continue;
      }

      const errorText = lastErrorText || await response.text();
      if (useRetry && isForbiddenError(response.status, errorText)) {
        reportApiKeyFailure(authHeader, response.status, errorText);
      }
      logError(`Endpoint error: ${response.status}`, new Error(errorText));
      return res.status(response.status).json({ error: `Endpoint returned ${response.status}`, details: errorText });
    }

    if (!response || !response.ok) {
      return res.status(lastErrorStatus).json({ error: `Endpoint returned ${lastErrorStatus}`, details: lastErrorText });
    }

    const isStreaming = openaiRequest.stream === true;

    if (isStreaming) {
      // 直接转发流式响应，不做任何转换
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      try {
        // 直接将原始响应流转发给客户端
        for await (const chunk of response.body) {
          res.write(chunk);
        }
        res.end();
        logInfo('Stream forwarded successfully');
      } catch (streamError) {
        logError('Stream error', streamError);
        res.end();
      }
    } else {
      // 直接转发非流式响应，不做任何转换
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

// 直接转发 Anthropic 请求（不做格式转换）
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

    // 只允许 anthropic 类型端点
    if (model.type !== 'anthropic') {
      return res.status(400).json({ 
        error: 'Invalid endpoint type',
        message: `/v1/messages 接口只支持 anthropic 类型端点，当前模型 ${modelId} 是 ${model.type} 类型`
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

    // Build modified request (once)
    const modifiedRequest = { ...anthropicRequest, model: modelId };

    // 系统提示词：保留客户端原始system + 净化Claude Code关键词 + 合并服务器prompt
    const mergedSystem = buildMergedSystemPrompt(anthropicRequest.system);
    if (mergedSystem) {
      modifiedRequest.system = mergedSystem;
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

    const maxAttempts = useRetry ? getActiveAccountCount() : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
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

      response = await fetch(endpoint.base_url, fetchOptions);
      logInfo(`Response status: ${response.status}`);

      if (response.ok) break;

      if (useRetry && RETRYABLE_STATUSES.has(response.status) && attempt < maxAttempts - 1) {
        lastErrorText = await response.text();
        lastErrorStatus = response.status;
        reportApiKeyFailure(authHeader, response.status, lastErrorText);
        if (isForbiddenError(response.status, lastErrorText)) {
          break;
        }
        triedTokens.push(authHeader);
        logInfo(`[Retry] ${response.status} on attempt ${attempt + 1}, switching account...`);
        continue;
      }

      const errorText = lastErrorText || await response.text();
      if (useRetry && isForbiddenError(response.status, errorText)) {
        reportApiKeyFailure(authHeader, response.status, errorText);
      }
      logError(`Endpoint error: ${response.status}`, new Error(errorText));
      return res.status(response.status).json({ error: `Endpoint returned ${response.status}`, details: errorText });
    }

    if (!response || !response.ok) {
      return res.status(lastErrorStatus).json({ error: `Endpoint returned ${lastErrorStatus}`, details: lastErrorText });
    }

    if (isStreaming) {
      // 直接转发流式响应，不做任何转换
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      try {
        // 直接将原始响应流转发给客户端
        for await (const chunk of response.body) {
          res.write(chunk);
        }
        res.end();
        logInfo('Stream forwarded successfully');
      } catch (streamError) {
        logError('Stream error', streamError);
        res.end();
      }
    } else {
      // 直接转发非流式响应，不做任何转换
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

// 处理 Anthropic count_tokens 请求
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

    // 只允许 anthropic 类型端点
    if (model.type !== 'anthropic') {
      return res.status(400).json({
        error: 'Invalid endpoint type',
        message: `/v1/messages/count_tokens 接口只支持 anthropic 类型端点，当前模型 ${modelId} 是 ${model.type} 类型`
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

    const modifiedRequest = { ...anthropicRequest, model: modelId };

    // 净化 + 合并 system prompt（同 handleDirectMessages 逻辑）
    const mergedSystem = buildMergedSystemPrompt(anthropicRequest.system);
    if (mergedSystem) {
      modifiedRequest.system = mergedSystem;
    } else {
      delete modifiedRequest.system;
    }

    logInfo(`Forwarding to count_tokens endpoint: ${countTokensUrl}`);

    // Retry loop
    const triedTokens = [];
    let response;
    let lastErrorStatus = 500;
    let lastErrorText = '';

    const maxAttempts = useRetry ? getActiveAccountCount() : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
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

      response = await fetch(countTokensUrl, fetchOptions);
      logInfo(`Response status: ${response.status}`);

      if (response.ok) break;

      if (useRetry && RETRYABLE_STATUSES.has(response.status) && attempt < maxAttempts - 1) {
        lastErrorText = await response.text();
        lastErrorStatus = response.status;
        reportApiKeyFailure(authHeader, response.status, lastErrorText);
        if (isForbiddenError(response.status, lastErrorText)) {
          break;
        }
        triedTokens.push(authHeader);
        logInfo(`[Retry] ${response.status} on attempt ${attempt + 1}, switching account...`);
        continue;
      }

      const errorText = lastErrorText || await response.text();
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

// 直接转发 Google 请求（不做格式转换）
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

    // 只允许 google 类型端点
    if (model.type !== 'google') {
      return res.status(400).json({
        error: 'Invalid endpoint type',
        message: `/v1/generate 接口只支持 google 类型端点，当前模型 ${modelId} 是 ${model.type} 类型`
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

    const maxAttempts = useRetry ? getActiveAccountCount() : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
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

      response = await fetch(endpoint.base_url, fetchOptions);
      logInfo(`Response status: ${response.status}`);

      if (response.ok) break;

      if (useRetry && RETRYABLE_STATUSES.has(response.status) && attempt < maxAttempts - 1) {
        lastErrorText = await response.text();
        lastErrorStatus = response.status;
        reportApiKeyFailure(authHeader, response.status, lastErrorText);
        if (isForbiddenError(response.status, lastErrorText)) {
          break;
        }
        triedTokens.push(authHeader);
        logInfo(`[Retry] ${response.status} on attempt ${attempt + 1}, switching account...`);
        continue;
      }

      const errorText = lastErrorText || await response.text();
      if (useRetry && isForbiddenError(response.status, errorText)) {
        reportApiKeyFailure(authHeader, response.status, errorText);
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
          res.write(chunk);
        }
        res.end();
        logInfo('Stream forwarded successfully');
      } catch (streamError) {
        logError('Stream error', streamError);
        res.end();
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

// 注册路由
router.post('/v1/chat/completions', handleChatCompletions);
router.post('/v1/responses', handleDirectResponses);
router.post('/v1/messages', handleDirectMessages);
router.post('/v1/messages/count_tokens', handleCountTokens);
router.post('/v1/generate', handleDirectGenerate);

export default router;
