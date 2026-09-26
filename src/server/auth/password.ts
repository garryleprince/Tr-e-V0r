import { base64UrlToBytes, bytesToBase64Url, timingSafeEqual } from '../util';

/**
 * Password hashing with PBKDF2-SHA-256 (WebCrypto, native on Workers).
 *
 * Workers cap PBKDF2 at 100 000 iterations; Argon2 is not native. The cap is
 * compensated by a 12-character minimum, per-IP throttling and account lockout
 * (docs/RISQUE_ET_SECURITE.md §B.2). The iteration count is stored with the
 * hash so it can be raised later without invalidating existing passwords.
 */

export const PBKDF2_ITERATIONS = 100_000;
export const MIN_PASSWORD_LENGTH = 12;

export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, iterations);
  return `pbkdf2-sha256$${iterations}$${bytesToBase64Url(salt)}$${bytesToBase64Url(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS) return false;
  const salt = base64UrlToBytes(parts[2]!);
  const expected = parts[3]!;
  const actual = bytesToBase64Url(await derive(password, salt, iterations));
  return timingSafeEqual(actual, expected);
}

export function passwordProblems(password: string): string[] {
  const problems: string[] = [];
  if (password.length < MIN_PASSWORD_LENGTH) problems.push(`au moins ${MIN_PASSWORD_LENGTH} caractères`);
  if (password.length > 256) problems.push('256 caractères au plus');
  if (new Set(password).size < 5) problems.push('trop peu de caractères différents');
  return problems;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}
