# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

droid2api is an OpenAI-compatible API proxy that routes requests to multiple LLM providers (Anthropic, OpenAI, Google, and Chinese models via Factory). It translates OpenAI-format requests into provider-native formats and converts responses back. All upstream calls go through Factory (api.factory.ai) as an intermediary.

- **Language**: JavaScript (Node.js, ES modules — `"type": "module"` in package.json)
- **Framework**: Express.js
- **No build step, no linter, no test suite** — direct ES6 module execution

## Commands

```bash
npm install        # Install dependencies (first time only)
npm start          # Start server on configured port (default 3000)
```

There is no test runner, no linting command, and no build process. The `dev` script is identical to `start`.

## Architecture

### Request Pipeline

```
Client (OpenAI format) → routes.js → config.js (resolve model/endpoint)
  → auth.js (get API key) → transformers/request-*.js (format conversion)
  → proxy-manager.js (select proxy) → Factory upstream API
  → transformers/response-*.js (convert back to OpenAI format) → Client
```

### Provider Type System

Each model in `config.json` has a `type` field that determines which transformer pair is used:

| type        | Request transformer          | Response transformer          | Upstream format |
|-------------|------------------------------|-------------------------------|-----------------|
| `anthropic` | `request-anthropic.js`       | `response-anthropic.js`       | Anthropic Messages API |
| `openai`    | `request-openai.js`          | `response-openai.js`          | OpenAI Responses API |
| `google`    | `request-google.js`          | `response-google.js`          | Google GenerateContent |
| `common`    | `request-common.js`          | (uses OpenAI response path)   | OpenAI Chat Completions |

The `provider` field in model config is separate from `type` — it's used for auth/billing routing, not format selection.

### Authentication Priority (highest to lowest)

1. `FACTORY_API_KEY` env var — fixed key, no refresh
2. `DROID_REFRESH_KEY` env var — auto-refresh via WorkOS OAuth every 6 hours
3. Multi-account system (`accounts.json`) — round-robin with health tracking and cooldowns
4. Client `Authorization` header — passthrough fallback

### Key Modules

- **`server.js`** — Express app setup, middleware, startup sequence (loads config → user-agent updater → account manager → auth → background tasks)
- **`routes.js`** — Core routing logic for all `/v1/*` endpoints. Handles model resolution, transformer dispatch, streaming vs non-streaming, retry with account rotation on 401/402/403/429
- **`config.js`** — Lazy-loaded singleton reading `config.json`. All config access goes through exported getter functions (`getModelById`, `getEndpointByType`, `getModelReasoning`, etc.)
- **`auth.js`** — API key management, WorkOS token refresh, ULID generation for request IDs
- **`account-manager.js`** — Multi-account persistence to `accounts.json`, per-account cooldown (3s), background tasks for token refresh (hourly) and balance checks (30min)
- **`proxy-manager.js`** — Round-robin proxy rotation with health tracking and cooldown on failure
- **`admin-routes.js` / `admin-auth.js` / `admin-ui.js`** — Web admin dashboard at `/admin` with session-based auth (in-memory sessions, 24h TTL)

### API Endpoints

- `POST /v1/chat/completions` — Main endpoint: accepts OpenAI format, auto-converts per model type
- `POST /v1/messages` — Anthropic passthrough (adds auth headers, system prompt injection)
- `POST /v1/responses` — OpenAI passthrough
- `POST /v1/generate` — Google passthrough
- `POST /v1/messages/count_tokens` — Token counting passthrough
- `GET /v1/models` — Lists models from config.json

### Reasoning Level System

Models in `config.json` have a `reasoning` field: `auto` | `off` | `low` | `medium` | `high`. Each transformer injects provider-specific reasoning parameters:
- **Anthropic**: `thinking` field with `budget_tokens` (4096/12288/24576)
- **OpenAI**: `reasoning.effort` parameter
- **Google**: `thinkingConfig.thinkingLevel` (LOW/MEDIUM/HIGH)
- **`auto`**: passes through client's reasoning fields unchanged

### Retry Logic

`routes.js` retries on retryable status codes (401, 402, 403, 429) by rotating to the next account. Proxy errors (502, 503, 504) trigger proxy rotation. Accounts get a 3-second cooldown after failures.

## Configuration

- **`config.json`** — Port, model definitions (name/id/type/reasoning/provider/fast), upstream endpoints, proxy list, system prompts, dev_mode flag
- **`accounts.json`** — Auto-generated multi-account state (do not edit manually while server is running)
- **`.env.example`** — Shows `FACTORY_API_KEY` and `DROID_REFRESH_KEY` env vars

To add a new model, add an entry to the `models` array in `config.json` with `name`, `id`, `type` (determines transformer), `reasoning`, and `provider`. To add a new provider, create `transformers/request-<provider>.js` and `transformers/response-<provider>.js`, then wire them in `routes.js`.

## Docker

```bash
docker build -t droid2api .
docker-compose up -d
```

Uses `node:24-alpine`. See `DOCKER_DEPLOY.md` for cloud platform deployment guides (Render, Railway, Fly.io, GCP, AWS).
