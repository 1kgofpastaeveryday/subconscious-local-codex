/**
 * Codex token management for letta-local.
 *
 * Reads tokens from ~/.codex/auth.json (written by Codex CLI).
 * Handles automatic refresh when tokens expire.
 * Uses chatgpt.com/backend-api (not api.openai.com) — no model.request scope needed.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_AUTH_FILE = path.join(os.homedir(), '.codex', 'auth.json');

// ============================================
// Types
// ============================================

interface CodexAuthFile {
  auth_mode: string;
  tokens: {
    access_token: string;
    refresh_token: string;
    account_id: string;
  };
  last_refresh?: string;
}

export interface CodexTokens {
  access_token: string;
  refresh_token: string;
  account_id: string;
  expires_at: number; // ms since epoch
}

// ============================================
// JWT Decode
// ============================================

function decodeJwt(token: string): any {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
}

function getExpiresAt(accessToken: string): number {
  const payload = decodeJwt(accessToken);
  if (payload?.exp) return payload.exp * 1000;
  // Default: assume 1 hour from now
  return Date.now() + 3600_000;
}

function getAccountId(accessToken: string): string | null {
  const payload = decodeJwt(accessToken);
  const accountId = payload?.['https://api.openai.com/auth']?.chatgpt_account_id;
  return typeof accountId === 'string' && accountId.length > 0 ? accountId : null;
}

// ============================================
// Token Storage
// ============================================

let cachedTokens: CodexTokens | null = null;

function loadFromCodexAuth(): CodexTokens | null {
  try {
    if (!fs.existsSync(CODEX_AUTH_FILE)) return null;
    const data: CodexAuthFile = JSON.parse(fs.readFileSync(CODEX_AUTH_FILE, 'utf-8'));
    if (!data.tokens?.access_token || !data.tokens?.refresh_token) return null;

    return {
      access_token: data.tokens.access_token,
      refresh_token: data.tokens.refresh_token,
      account_id: data.tokens.account_id || getAccountId(data.tokens.access_token) || '',
      expires_at: getExpiresAt(data.tokens.access_token),
    };
  } catch (err: any) {
    console.error(`[codex-auth] Failed to read ${CODEX_AUTH_FILE}: ${err.message}`);
    return null;
  }
}

function saveToCodexAuth(tokens: CodexTokens): void {
  try {
    const data: CodexAuthFile = {
      auth_mode: 'chatgpt',
      tokens: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        account_id: tokens.account_id,
      },
      last_refresh: new Date().toISOString(),
    };

    // Preserve id_token and OPENAI_API_KEY if they exist
    if (fs.existsSync(CODEX_AUTH_FILE)) {
      try {
        const existing = JSON.parse(fs.readFileSync(CODEX_AUTH_FILE, 'utf-8'));
        if (existing.tokens?.id_token) {
          (data.tokens as any).id_token = existing.tokens.id_token;
        }
        if (existing.OPENAI_API_KEY !== undefined) {
          (data as any).OPENAI_API_KEY = existing.OPENAI_API_KEY;
        }
      } catch {}
    }

    fs.writeFileSync(CODEX_AUTH_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err: any) {
    console.warn(`[codex-auth] Failed to save tokens: ${err.message}`);
  }
}

// ============================================
// Token Refresh
// ============================================

async function refreshTokens(refreshToken: string): Promise<CodexTokens> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Token refresh failed: ${response.status} ${text}`);
  }

  const json: any = await response.json();
  if (!json.access_token || !json.refresh_token) {
    throw new Error('Refresh response missing fields');
  }

  const accountId = getAccountId(json.access_token);
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    account_id: accountId || '',
    expires_at: Date.now() + (json.expires_in || 3600) * 1000,
  };
}

// ============================================
// Public API
// ============================================

/**
 * Get valid Codex tokens. Refreshes if expired.
 */
export async function getCodexTokens(): Promise<CodexTokens> {
  // Use cached if still valid (with 60s buffer)
  if (cachedTokens && Date.now() < cachedTokens.expires_at - 60_000) {
    return cachedTokens;
  }

  // Load from file
  let tokens = loadFromCodexAuth();
  if (!tokens) {
    throw new Error(`No Codex auth found at ${CODEX_AUTH_FILE}. Run "codex" first to authenticate.`);
  }

  // Check if expired
  if (Date.now() >= tokens.expires_at - 60_000) {
    console.log('[codex-auth] Token expired, refreshing...');
    try {
      tokens = await refreshTokens(tokens.refresh_token);
      saveToCodexAuth(tokens);
      console.log('[codex-auth] Token refreshed');
    } catch (err: any) {
      console.error(`[codex-auth] Refresh failed: ${err.message}`);
      // Try using the existing token anyway — it might still work
      tokens = loadFromCodexAuth()!;
    }
  }

  cachedTokens = tokens;
  return tokens;
}

/**
 * Check if Codex auth file exists.
 */
export function hasCodexAuth(): boolean {
  return fs.existsSync(CODEX_AUTH_FILE);
}

// Legacy exports for backward compat with server.ts import
export const getAccessToken = async () => (await getCodexTokens()).access_token;
export const hasTokens = hasCodexAuth;
