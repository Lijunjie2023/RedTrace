import {
  createCipheriv,
  createDecipheriv,
  createSecretKey,
  randomBytes,
  type KeyObject
} from "node:crypto";
import type { EncryptedCredential } from "./types.js";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH_BYTES = 32;
const IV_LENGTH_BYTES = 12;
const BASE64_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

export class CredentialConfigError extends Error {
  readonly code = "credential_encryption_unavailable";

  constructor() {
    super("凭证加密服务暂时不可用。");
    this.name = "CredentialConfigError";
  }
}

export class CredentialDecryptionError extends Error {
  readonly code = "credential_decryption_failed";

  constructor() {
    super("凭证读取失败。");
    this.name = "CredentialDecryptionError";
  }
}

export function parseCredentialEncryptionKey(env: NodeJS.ProcessEnv): Buffer {
  const encoded = env.CREDENTIAL_ENCRYPTION_KEY_BASE64?.trim();
  if (!encoded || !BASE64_KEY_PATTERN.test(encoded)) throw new CredentialConfigError();

  const key = Buffer.from(encoded, "base64");
  if (key.length !== KEY_LENGTH_BYTES || key.toString("base64") !== encoded) {
    throw new CredentialConfigError();
  }
  return key;
}

export class CredentialCrypto {
  private readonly key: KeyObject;

  constructor(key: Uint8Array) {
    if (key.byteLength !== KEY_LENGTH_BYTES) throw new CredentialConfigError();
    this.key = createSecretKey(Buffer.from(key));
  }

  encrypt(secret: string): EncryptedCredential {
    const iv = randomBytes(IV_LENGTH_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return {
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64")
    };
  }

  decrypt(encrypted: EncryptedCredential): string {
    try {
      const iv = Buffer.from(encrypted.iv, "base64");
      const authTag = Buffer.from(encrypted.authTag, "base64");
      if (iv.length !== IV_LENGTH_BYTES || authTag.length !== 16) throw new Error("invalid_envelope");

      const decipher = createDecipheriv(ALGORITHM, this.key, iv);
      decipher.setAuthTag(authTag);
      return Buffer.concat([
        decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
        decipher.final()
      ]).toString("utf8");
    } catch {
      throw new CredentialDecryptionError();
    }
  }
}

export function createCredentialCrypto(env: NodeJS.ProcessEnv = process.env): CredentialCrypto {
  return new CredentialCrypto(parseCredentialEncryptionKey(env));
}
