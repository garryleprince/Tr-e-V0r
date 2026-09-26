import { hashPassword, passwordProblems, verifyPassword } from '../../src/server/auth/password';
import {
  createOwner,
  createSession,
  findUserByEmail,
  recordFailedLogin,
  resolveSession,
  SESSION_IDLE_MS,
} from '../../src/server/auth/sessions';
import { sha256Hex } from '../../src/server/util';
import { TestD1 } from '../helpers/d1';

describe('mots de passe (PBKDF2-SHA-256)', () => {
  it('vérifie le bon mot de passe et refuse le mauvais', async () => {
    const h = await hashPassword('correct horse battery staple', 1000);
    expect(h.startsWith('pbkdf2-sha256$1000$')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', h)).toBe(true);
    expect(await verifyPassword('Correct horse battery staple', h)).toBe(false);
  });

  it('deux empreintes du même mot de passe diffèrent (sel aléatoire)', async () => {
    expect(await hashPassword('same-password-123', 1000)).not.toBe(await hashPassword('same-password-123', 1000));
  });

  it('refuse une empreinte altérée ou un nombre d’itérations hors plafond', async () => {
    const h = await hashPassword('another-password-1', 1000);
    expect(await verifyPassword('another-password-1', h.replace('$1000$', '$999999$'))).toBe(false);
    expect(await verifyPassword('x', 'md5$abc')).toBe(false);
  });

  it('politique de longueur', () => {
    expect(passwordProblems('court')).not.toEqual([]);
    expect(passwordProblems('une phrase secrète assez longue')).toEqual([]);
    expect(passwordProblems('aaaaaaaaaaaaaaaa')).toContain('trop peu de caractères différents');
  });
});

describe('compte propriétaire et sessions', () => {
  it('un seul propriétaire, même avec deux créations', async () => {
    const db = new TestD1().asD1();
    expect(await createOwner(db, 'me@example.com', 'x', 1)).not.toBeNull();
    expect(await createOwner(db, 'other@example.com', 'y', 2)).toBeNull();
  });

  it('seule l’empreinte du jeton est stockée ; session invalide après inactivité', async () => {
    const t = new TestD1();
    const db = t.asD1();
    const userId = (await createOwner(db, 'me@example.com', 'x', 1))!;
    const token = await createSession(db, userId, 1_000, 'test', false);
    const stored = t.raw.prepare('SELECT token_hash FROM sessions').all() as { token_hash: string }[];
    expect(stored[0]!.token_hash).toBe(await sha256Hex(token));
    expect(stored[0]!.token_hash).not.toContain(token);
    expect(await resolveSession(db, token, 2_000)).not.toBeNull();
    expect(await resolveSession(db, token, 2_000 + SESSION_IDLE_MS + 1)).toBeNull();
    expect(await resolveSession(db, 'forged', 2_000)).toBeNull();
  });

  it('verrouille le compte après 5 échecs', async () => {
    const db = new TestD1().asD1();
    await createOwner(db, 'me@example.com', 'x', 1);
    for (let i = 0; i < 5; i++) {
      const u = (await findUserByEmail(db, 'me@example.com'))!;
      await recordFailedLogin(db, u, 10_000);
    }
    const u = (await findUserByEmail(db, 'me@example.com'))!;
    expect(u.lockedUntil).toBeGreaterThan(10_000);
  });
});
