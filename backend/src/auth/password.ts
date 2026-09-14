/** Password hashing with Bun's built-in argon2id. */

const OPTIONS = { algorithm: "argon2id" } as const;

export function hashPassword(plain: string): Promise<string> {
  return Bun.password.hash(plain, OPTIONS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(plain, hash);
  } catch {
    // A malformed stored hash must fail closed, not throw a 500.
    return false;
  }
}

let dummyHash: Promise<string> | null = null;

/**
 * Verifies against a throwaway hash so a login for an unknown username takes as
 * long as one for a real account — response time must not reveal which exist.
 */
export async function burnPasswordCheck(plain: string): Promise<void> {
  dummyHash ??= hashPassword("timing-equaliser-not-a-real-password");
  await verifyPassword(plain, await dummyHash);
}
