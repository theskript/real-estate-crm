/**
 * Client-side auth utilities. Token stored in localStorage under
 * 'teaka_token' / 'teaka_role' / 'teaka_name' / 'teaka_agent_id'.
 */

export const TOKEN_KEY = 'teaka_token';
export const ROLE_KEY = 'teaka_role';
export const NAME_KEY = 'teaka_name';
export const AGENT_ID_KEY = 'teaka_agent_id';

export function getToken() {
  return typeof localStorage !== 'undefined' ? localStorage.getItem(TOKEN_KEY) : null;
}
export function getRole() {
  return typeof localStorage !== 'undefined' ? localStorage.getItem(ROLE_KEY) : null;
}
export function getName() {
  return typeof localStorage !== 'undefined' ? localStorage.getItem(NAME_KEY) : null;
}
export function getAgentId() {
  return typeof localStorage !== 'undefined' ? localStorage.getItem(AGENT_ID_KEY) : null;
}
export function isOwner() {
  return getRole() === 'owner';
}

/** Decode JWT payload without verifying signature (client-side only, display purposes). */
export function decodePayload(token) {
  try {
    const part = token.split('.')[1];
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b64));
  } catch {
    return null;
  }
}

export function isAuthenticated() {
  const token = getToken();
  if (!token) return false;
  const payload = decodePayload(token);
  if (!payload) return false;
  return payload.exp > Math.floor(Date.now() / 1000);
}

/** Redirects to /login if not authenticated. Call at the top of every page's script. */
export function requireLogin() {
  if (!isAuthenticated()) {
    clearAuth();
    window.location.href = '/login';
  }
}

export function clearAuth() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ROLE_KEY);
  localStorage.removeItem(NAME_KEY);
  localStorage.removeItem(AGENT_ID_KEY);
}

export function storeAuth({ token, role, name, agentId }) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(ROLE_KEY, role);
  localStorage.setItem(NAME_KEY, name || '');
  if (agentId) localStorage.setItem(AGENT_ID_KEY, agentId);
}

/**
 * Authenticated fetch wrapper for Netlify function endpoints.
 * @param {string} endpoint - function name, e.g. 'leads'
 * @param {{ method?: string, body?: any, params?: Record<string,any> }} [options]
 */
export async function apiFetch(endpoint, { method = 'GET', body = null, params = {} } = {}) {
  const token = getToken();
  const url = new URL(`/.netlify/functions/${endpoint}`, window.location.origin);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    clearAuth();
    window.location.href = '/login';
    throw new Error('Session expired');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
export function formatDateTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
export function timeAgo(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000);
  if (h >= 24) return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return h > 0 ? `${h}h ago` : m > 0 ? `${m}m ago` : 'just now';
}
export function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
export function initials(name) {
  return (name || '?').split(' ').map(p => p[0]).join('').substring(0, 2).toUpperCase();
}
