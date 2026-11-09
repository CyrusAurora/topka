// Password hashing for user accounts (master design D6): argon2id with the OWASP baseline
// parameters. The native build ships prebuilt binaries, so installs need no compiler.
import { hash as argon2Hash, verify as argon2Verify, type Algorithm } from "@node-rs/argon2";

/** The lowest accepted password length, in code points (master design 3.5: at least 10). */
export const MIN_PASSWORD_LENGTH = 10;

const ARGON2ID = {
  // 2 is Algorithm.Argon2id, spelled out because the const enum cannot be read under
  // verbatimModuleSyntax. Memory and passes are OWASP's minimum for argon2id.
  algorithm: 2 as Algorithm,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

export function passwordTooWeak(password: string): boolean {
  return [...password].length < MIN_PASSWORD_LENGTH;
}

export function hashPassword(password: string): Promise<string> {
  return argon2Hash(password, ARGON2ID);
}

/** A stored hash that cannot be parsed verifies to false; it never throws. */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await argon2Verify(storedHash, password);
  } catch {
    return false;
  }
}
