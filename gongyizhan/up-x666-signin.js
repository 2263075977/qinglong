#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const DEFAULT_BASE_URL = 'https://up.x666.me';
const DEFAULT_TIMEOUT_MS = 30000;
const QUOTA_PER_TIME = 500;

class SignInError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'SignInError';
    this.details = details;
  }
}

function loadDotEnv() {
  const candidates = [
    path.join(process.cwd(), '.env'),
    path.join(__dirname, '..', '.env'),
  ];

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;

    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const equalsIndex = trimmed.indexOf('=');
      if (equalsIndex === -1) continue;

      const key = trimmed.slice(0, equalsIndex).trim();
      let value = trimmed.slice(equalsIndex + 1).trim();
      if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) continue;

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      process.env[key] = value;
    }
  }
}

function getConfig() {
  loadDotEnv();

  const cookie = (process.env.UP_X666_COOKIE || '').trim();
  if (!cookie) {
    throw new SignInError(
      'Missing UP_X666_COOKIE. Set it to the full Cookie header copied from an authenticated up.x666.me browser session.'
    );
  }

  const baseUrl = normalizeBaseUrl(process.env.UP_X666_BASE_URL || DEFAULT_BASE_URL);
  const timeoutMs = parsePositiveInteger(process.env.UP_X666_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);

  return { baseUrl, cookie, timeoutMs };
}

function parseArgs(argv) {
  const args = {
    help: false,
    statusOnly: false,
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--status-only') {
      args.statusOnly = true;
    } else {
      throw new SignInError(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printUsage() {
  console.log(`Usage: node scripts/up-x666-signin.js [options]

Options:
  --status-only   Validate the session and print today's sign-in status without spinning.
  -h, --help      Show this help.

Environment:
  UP_X666_COOKIE      Required full Cookie header from an authenticated browser session.
  UP_X666_BASE_URL    Optional, defaults to ${DEFAULT_BASE_URL}.
  UP_X666_TIMEOUT_MS  Optional, defaults to ${DEFAULT_TIMEOUT_MS}.`);
}

function normalizeBaseUrl(raw) {
  try {
    const url = new URL(raw);
    url.pathname = url.pathname.replace(/\/+$/, '');
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch (error) {
    throw new SignInError(`Invalid UP_X666_BASE_URL: ${raw}`);
  }
}

function parsePositiveInteger(raw, fallback) {
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function requestJson(config, apiPath, options = {}) {
  const method = options.method || 'GET';
  const url = new URL(apiPath, config.baseUrl);
  const siteOrigin = new URL(config.baseUrl).origin;
  const client = url.protocol === 'http:' ? http : https;

  const headers = {
    Accept: 'application/json',
    Cookie: config.cookie,
    Origin: siteOrigin,
    Referer: `${siteOrigin}/`,
    'User-Agent': 'up-x666-daily-signin/1.0 (+https://up.x666.me)',
    ...options.headers,
  };

  if (method !== 'GET' && method !== 'HEAD') {
    headers['Content-Length'] = '0';
  }

  const requestOptions = {
    method,
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
    path: `${url.pathname}${url.search}`,
    headers,
  };

  return new Promise((resolve, reject) => {
    const req = client.request(requestOptions, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        const statusCode = res.statusCode || 0;
        if (statusCode < 200 || statusCode >= 300) {
          reject(new SignInError(`HTTP ${statusCode} from ${method} ${apiPath}`, {
            statusCode,
            body: body.slice(0, 300),
          }));
          return;
        }

        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new SignInError(`Non-JSON response from ${method} ${apiPath}`, {
            body: body.slice(0, 300),
          }));
        }
      });
    });

    req.setTimeout(config.timeoutMs, () => {
      req.destroy(new SignInError(`Request timed out after ${config.timeoutMs}ms: ${method} ${apiPath}`));
    });

    req.on('error', reject);
    req.end();
  });
}

function assertSuccess(result, context) {
  if (!result || result.success !== true) {
    const message = result && (result.message || result.error)
      ? `${context}: ${result.message || result.error}`
      : `${context}: unexpected response`;
    throw new SignInError(message, { response: scrubResponse(result) });
  }
}

function scrubResponse(value) {
  if (!value || typeof value !== 'object') return value;
  const clone = { ...value };
  delete clone.cookie;
  delete clone.token;
  delete clone.access_token;
  delete clone.refresh_token;
  return clone;
}

function quotaToTimes(quota) {
  if (typeof quota !== 'number' || !Number.isFinite(quota)) return null;
  return quota / QUOTA_PER_TIME;
}

function describeQuota(quota) {
  const times = quotaToTimes(quota);
  if (times === null) return 'unknown';
  return `${times.toLocaleString('en-US')} times (${quota.toLocaleString('en-US')} quota)`;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const config = getConfig();
  console.log(`[up.x666] Start daily sign-in check at ${new Date().toISOString()}`);

  const userInfo = await requestJson(config, '/api/user/info');
  assertSuccess(userInfo, 'Session validation failed');

  const username = userInfo.username || userInfo.name || userInfo.linux_do_id || 'unknown user';
  console.log(`[up.x666] Session OK: ${username}`);

  const status = await requestJson(config, '/api/checkin/status');
  assertSuccess(status, 'Failed to fetch check-in status');

  if (args.statusOnly) {
    const canSpin = status.can_spin === false ? 'no' : 'yes';
    console.log(`[up.x666] Status only: can spin today: ${canSpin}.`);
    if (typeof status.total_quota === 'number') {
      console.log(`[up.x666] Total earned: ${describeQuota(status.total_quota)}`);
    }
    return;
  }

  if (status.can_spin === false) {
    console.log('[up.x666] Already signed in today; no spin needed.');
    if (typeof status.total_quota === 'number') {
      console.log(`[up.x666] Total earned: ${describeQuota(status.total_quota)}`);
    }
    return;
  }

  console.log('[up.x666] Sign-in is available; spinning now.');
  const spinResult = await requestJson(config, '/api/checkin/spin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  assertSuccess(spinResult, 'Spin failed');

  const prize = spinResult.quota_amount !== undefined
    ? describeQuota(spinResult.quota_amount)
    : 'unknown prize';
  const level = spinResult.level !== undefined ? `level ${spinResult.level}` : 'unknown level';
  console.log(`[up.x666] Spin succeeded: ${level}, prize ${prize}.`);
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`[up.x666] Failed: ${error.message}`);
    if (error instanceof SignInError && error.details && Object.keys(error.details).length > 0) {
      console.error(`[up.x666] Details: ${JSON.stringify(error.details)}`);
    }
    process.exitCode = 1;
  });
}

module.exports = {
  SignInError,
  describeQuota,
  getConfig,
  normalizeBaseUrl,
  parseArgs,
  quotaToTimes,
  requestJson,
  run,
};
