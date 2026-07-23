import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const FORMAT_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function encryptionKey(): Buffer {
  const secret = process.env.CONNECTOR_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) {
    throw new Error('CONNECTOR_ENCRYPTION_KEY must contain at least 32 characters');
  }
  if (secret === process.env.AUTH_SECRET) {
    throw new Error('CONNECTOR_ENCRYPTION_KEY must be distinct from AUTH_SECRET');
  }
  // Accept the documented base64 secret as well as ordinary high-entropy text
  // without making deployment key formatting part of the ciphertext format.
  return createHash('sha256').update(secret, 'utf8').digest();
}

/** AES-256-GCM with a fresh nonce and an explicit version byte. */
export function encryptConnectorConfiguration(configuration: Record<string, unknown>): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(configuration), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([
    Buffer.from([FORMAT_VERSION]),
    iv,
    cipher.getAuthTag(),
    ciphertext,
  ]);
}

export function decryptConnectorConfiguration(payload: Buffer): Record<string, unknown> {
  if (payload.length < 1 + IV_BYTES + TAG_BYTES || payload[0] !== FORMAT_VERSION) {
    throw new Error('Unsupported connector configuration format');
  }
  const ivStart = 1;
  const tagStart = ivStart + IV_BYTES;
  const dataStart = tagStart + TAG_BYTES;
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    payload.subarray(ivStart, tagStart),
  );
  decipher.setAuthTag(payload.subarray(tagStart, dataStart));
  const plaintext = Buffer.concat([
    decipher.update(payload.subarray(dataStart)),
    decipher.final(),
  ]).toString('utf8');
  const decoded: unknown = JSON.parse(plaintext);
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('Connector configuration is not an object');
  }
  return decoded as Record<string, unknown>;
}

export function summarizeConnectorConfiguration(
  configuration: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!configuration) return { configured: false, configured_fields: [] };
  return {
    configured: Object.keys(configuration).length > 0,
    // Field names help an operator diagnose setup while values remain encrypted.
    configured_fields: Object.keys(configuration).sort(),
  };
}
