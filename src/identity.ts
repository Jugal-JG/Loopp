import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ServiceError } from './provider';

export const googleEnabled = () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.APP_ORIGIN);
export const adminEmail = () => process.env.ADMIN_EMAIL?.trim().toLowerCase();
export const isAdmin = (email: string | null, kind: string | null) =>
  Boolean(email && email === adminEmail() && (kind === 'admin' || kind === 'google'));
export const googleProfile = (email: string) =>
  (process.env.PRO_EMAILS ?? '').toLowerCase().split(',').map(value => value.trim()).includes(email) ? 'pro' : 'basic';
export function secretMatches(input: string, secret?: string) {
  return Boolean(secret) && timingSafeEqual(createHash('sha256').update(input).digest(), createHash('sha256').update(secret!).digest());
}
export function cookie(name: string, value: string, maxAge: number, secure: boolean) {
  return `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
export function readCookie(header: string | undefined, name: string) {
  return header?.split(';').map(item => item.trim()).find(item => item.startsWith(`${name}=`))?.slice(name.length + 1);
}

function redirectUri() {
  if (!googleEnabled()) throw new ServiceError('google_not_configured', 503);
  return new URL('/api/support', process.env.APP_ORIGIN).href;
}

export function googleStart() {
  const state = randomBytes(24).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!, redirect_uri: redirectUri(), response_type: 'code',
    scope: 'openid email', state, prompt: 'select_account',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  }).toString();
  return { url: url.href, stateCookie: `${state}.${verifier}` };
}

export async function googleFinish(url: URL, flowCookie?: string) {
  const [state, verifier] = flowCookie?.split('.') ?? [];
  const code = url.searchParams.get('code');
  if (!state || !verifier || !code || url.searchParams.get('state') !== state) throw new ServiceError('google_sign_in_failed', 400);
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', signal: AbortSignal.timeout(8000),
    body: new URLSearchParams({ code, code_verifier: verifier, redirect_uri: redirectUri(), grant_type: 'authorization_code',
      client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET! }),
  });
  if (!tokenResponse.ok) throw new ServiceError('google_sign_in_failed', 502);
  const { access_token } = await tokenResponse.json();
  if (typeof access_token !== 'string') throw new ServiceError('google_sign_in_failed', 502);
  const userResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${access_token}` }, signal: AbortSignal.timeout(8000),
  });
  if (!userResponse.ok) throw new ServiceError('google_sign_in_failed', 502);
  const user = await userResponse.json();
  if (typeof user.email !== 'string' || typeof user.sub !== 'string' || user.email_verified !== true) throw new ServiceError('google_email_unverified', 403);
  return user.email.toLowerCase();
}
