import crypto from 'crypto';
import { promisify } from 'util';

/**
 * Self-hosted password hashing using Node's built-in scrypt — no native
 * modules (bcrypt/argon2 need platform binaries that break the Windows/
 * cross-platform build), and no extra dependency. Stored format is
 * "scrypt$<salt-hex>$<hash-hex>" so the params travel with the hash.
 */
const scrypt = promisify(crypto.scrypt) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

const KEYLEN = 64;
const SALT_BYTES = 16;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_BYTES).toString('hex');
  const derived = (await scrypt(password, salt, KEYLEN)).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export async function verifyPassword(
  password: string,
  stored: string | null | undefined,
): Promise<boolean> {
  if (!stored) return false;
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const derived = await scrypt(password, salt, KEYLEN);
  const hashBuf = Buffer.from(hash, 'hex');
  // Length check guards timingSafeEqual, which throws on mismatched lengths.
  if (hashBuf.length !== derived.length) return false;
  return crypto.timingSafeEqual(hashBuf, derived);
}
