import { logDebug } from '../logger.js';
import { getSystemPrompt, getUserAgent, getModelReasoning } from '../config.js';

export function transformToCommon(openaiRequest) {
  logDebug('Transforming OpenAI request to Common format');
  
  // Mostly keep OpenAI format, just prepend system message to messages
  const commonRequest = {
    ...openaiRequest
  };

  const systemPrompt = getSystemPrompt();
  
  if (systemPrompt) {
    // Check if there's already a system message
    const hasSystemMessage = commonRequest.messages?.some(m => m.role === 'system');
    
    if (hasSystemMessage) {
      // Prepend our system prompt to the first system message
      commonRequest.messages = commonRequest.messages.map((msg, index) => {
        if (msg.role === 'system' && index === commonRequest.messages.findIndex(m => m.role === 'system')) {
          return {
            role: 'system',
            content: systemPrompt + (typeof msg.content === 'string' ? msg.content : '')
          };
        }
        return msg;
      });
    } else {
      // No system message found, prepend one at the beginning
      commonRequest.messages = [
        {
          role: 'system',
          content: systemPrompt
        },
        ...(commonRequest.messages || [])
      ];
    }
  }

  // Handle reasoning_effort field based on model configuration
  const reasoningLevel = getModelReasoning(openaiRequest.model);
  if (reasoningLevel === 'auto') {
    // Auto mode: preserve original request's reasoning_effort field exactly as-is
    // If original request has reasoning_effort field, keep it; otherwise don't add one
  } else if (reasoningLevel && ['low', 'medium', 'high', 'xhigh'].includes(reasoningLevel)) {
    // Specific level: override with model configuration
    commonRequest.reasoning_effort = reasoningLevel;
  } else {
    // Off or invalid: explicitly remove reasoning_effort field
    // This ensures any reasoning_effort field from the original request is deleted
    delete commonRequest.reasoning_effort;
  }

  logDebug('Transformed Common request', commonRequest);
  return commonRequest;
}

export function getCommonHeaders(authHeader, clientHeaders = {}, provider = 'baseten') {
  // Generate unique IDs if not provided
  const sessionId = clientHeaders['x-session-id'] || generateUUID();
  const messageId = clientHeaders['x-assistant-message-id'] || generateUUID();
  
  const headers = {
    'accept': 'application/json',
    'content-type': 'application/json',
    'authorization': authHeader || '',
    'x-api-provider': provider,
    'x-factory-client': 'cli',
    'x-session-id': sessionId,
    'x-assistant-message-id': messageId,
    'user-agent': getUserAgent(),
    'connection': 'keep-alive'
  };

  // Pass through Stainless SDK headers with defaults
  const stainlessDefaults = {
    'x-stainless-arch': 'x64',
    'x-stainless-lang': 'js',
    'x-stainless-os': 'MacOS',
    'x-stainless-runtime': 'node',
    'x-stainless-retry-count': '0',
    'x-stainless-package-version': '5.23.2',
    'x-stainless-runtime-version': 'v24.3.0'
  };

  // Copy Stainless headers from client or use defaults
  Object.keys(stainlessDefaults).forEach(header => {
    headers[header] = clientHeaders[header] || stainlessDefaults[header];
  });

  return headers;
}

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}
