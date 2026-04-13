import express from 'express';
import compression from 'compression';
import { loadConfig, isDevMode, getPort } from './config.js';
import { logInfo, logError } from './logger.js';
import router from './routes.js';
import { initializeAuth } from './auth.js';
import { initializeUserAgentUpdater } from './user-agent-updater.js';
import { initAccountManager, startBackgroundTasks, stopBackgroundTasks } from './account-manager.js';
import adminRouter from './admin-routes.js';

const app = express();

// gzip/deflate/br 压缩响应，节省下行带宽（跳过 SSE 流式响应）
app.use(compression({
  threshold: 512,       // 小于 512B 不压缩
  level: 6,             // zlib 压缩级别 (1=快 9=小, 6=平衡)
  filter: (req, res) => {
    // SSE 流式响应不压缩，避免 chunk 被缓冲导致客户端无法实时接收
    if (res.getHeader('Content-Type')?.includes('text/event-stream')) {
      return false;
    }
    return compression.filter(req, res);
  },
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, anthropic-version');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(adminRouter);
app.use(router);

app.get('/', (req, res) => {
  res.json({
    name: 'droid2api',
    version: '1.0.0',
    description: 'OpenAI Compatible API Proxy',
    endpoints: [
      'GET /v1/models',
      'POST /v1/chat/completions',
      'POST /v1/responses',
      'POST /v1/messages',
      'POST /v1/messages/count_tokens',
      'POST /v1/generate'
    ]
  });
});

// 404 handler - catch all unmatched routes
app.use((req, res, next) => {
  const errorInfo = {
    timestamp: new Date().toISOString(),
    method: req.method,
    url: req.originalUrl || req.url,
    path: req.path,
    query: req.query,
    params: req.params,
    body: req.body,
    headers: {
      'content-type': req.headers['content-type'],
      'user-agent': req.headers['user-agent'],
      'origin': req.headers['origin'],
      'referer': req.headers['referer']
    },
    ip: req.ip || req.connection.remoteAddress
  };

  console.error('\n' + '='.repeat(80));
  console.error('Invalid request path');
  console.error('='.repeat(80));
  console.error(`Time: ${errorInfo.timestamp}`);
  console.error(`Method: ${errorInfo.method}`);
  console.error(`URL: ${errorInfo.url}`);
  console.error(`Path: ${errorInfo.path}`);

  if (Object.keys(errorInfo.query).length > 0) {
    console.error(`Query params: ${JSON.stringify(errorInfo.query, null, 2)}`);
  }

  if (errorInfo.body && Object.keys(errorInfo.body).length > 0) {
    console.error(`Request body: ${JSON.stringify(errorInfo.body, null, 2)}`);
  }

  console.error(`Client IP: ${errorInfo.ip}`);
  console.error(`User-Agent: ${errorInfo.headers['user-agent'] || 'N/A'}`);

  if (errorInfo.headers.referer) {
    console.error(`Referer: ${errorInfo.headers.referer}`);
  }

  console.error('='.repeat(80) + '\n');

  logError('Invalid request path', errorInfo);

  res.status(404).json({
    error: 'Not Found',
    message: `Path ${req.method} ${req.path} does not exist`,
    timestamp: errorInfo.timestamp,
    availableEndpoints: [
      'GET /v1/models',
      'POST /v1/chat/completions',
      'POST /v1/responses',
      'POST /v1/messages',
      'POST /v1/messages/count_tokens',
      'POST /v1/generate'
    ]
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  logError('Unhandled error', err);
  res.status(500).json({
    error: 'Internal server error',
    message: isDevMode() ? err.message : undefined
  });
});

(async () => {
  try {
    loadConfig();
    logInfo('Configuration loaded successfully');
    logInfo(`Dev mode: ${isDevMode()}`);

    // Initialize User-Agent version updater
    initializeUserAgentUpdater();

    // Initialize account manager (multi-account system)
    initAccountManager();

    // Initialize auth system (load and setup API key if needed)
    // This won't throw error if no auth config is found - will use client auth
    await initializeAuth();

    // Start background tasks (token refresh & balance check)
    startBackgroundTasks();
    
    const PORT = getPort();
  logInfo(`Starting server on port ${PORT}...`);
  
  const server = app.listen(PORT)
    .on('listening', () => {
      logInfo(`Server running on http://localhost:${PORT}`);
      logInfo('Available endpoints:');
      logInfo('  GET  /v1/models');
      logInfo('  POST /v1/chat/completions');
      logInfo('  POST /v1/responses');
      logInfo('  POST /v1/messages');
      logInfo('  POST /v1/messages/count_tokens');
      logInfo('  POST /v1/generate');
      logInfo('  GET  /admin (Admin Console)');
    })
    .on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`\n${'='.repeat(80)}`);
        console.error(`ERROR: Port ${PORT} is already in use!`);
        console.error('');
        console.error('Please choose one of the following options:');
        console.error(`  1. Stop the process using port ${PORT}:`);
        console.error(`     lsof -ti:${PORT} | xargs kill`);
        console.error('');
        console.error('  2. Change the port in config.json:');
        console.error('     Edit config.json and modify the "port" field');
        console.error(`${'='.repeat(80)}\n`);
        process.exit(1);
      } else {
        logError('Failed to start server', err);
        process.exit(1);
      }
    });
    // Graceful shutdown
    const shutdown = () => {
      logInfo('Shutting down...');
      stopBackgroundTasks();
      server.close(() => {
        logInfo('Server closed');
        process.exit(0);
      });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

  } catch (error) {
    logError('Failed to start server', error);
    process.exit(1);
  }
})();
