import * as argon2 from 'argon2';
import type { PasswordHasher } from './ports';

/**
 * Argon2id password hashing. Parameters follow the OWASP recommendation
 * for Argon2id (memory 19 MiB, 2 iterations, 1 lane). The `argon2`
 * package (0.45.2) is a declared dependency and its native binding
 * loads in this environment. Passwords are never logged or returned.
 */
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export class Argon2PasswordHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    return argon2.hash(password, ARGON2_OPTIONS);
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      // Malformed hash or verification failure: treat as "no match",
      // never leak the reason.
      return false;
    }
  }
}
