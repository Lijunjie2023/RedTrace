import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { CredentialCrypto } from "./crypto.js";
import {
  CREDENTIAL_KINDS,
  type CredentialKind,
  type ServiceCredentialSummary
} from "./types.js";

interface CredentialRow extends RowDataPacket {
  credentialKind: CredentialKind;
  ciphertext: string;
  iv: string;
  authTag: string;
  lastFour: string;
  updatedAt: Date;
}

export class CredentialStorageError extends Error {
  readonly code = "credential_storage_failed";

  constructor() {
    super("凭证保存失败。");
    this.name = "CredentialStorageError";
  }
}

function configuredSummary(kind: CredentialKind, row: CredentialRow): ServiceCredentialSummary {
  return {
    kind,
    configured: true,
    lastFour: row.lastFour,
    updatedAt: row.updatedAt.toISOString()
  };
}

function missingSummary(kind: CredentialKind): ServiceCredentialSummary {
  return { kind, configured: false, lastFour: null, updatedAt: null };
}

export class ServiceCredentialRepository {
  constructor(
    private readonly pool: Pool,
    private readonly crypto: CredentialCrypto
  ) {}

  async listSummaries(): Promise<ServiceCredentialSummary[]> {
    const [rows] = await this.pool.execute<CredentialRow[]>(
      `SELECT credential_kind AS credentialKind, ciphertext, iv,
              auth_tag AS authTag, last_four AS lastFour, updated_at AS updatedAt
       FROM service_credentials`
    );
    const byKind = new Map(rows.map((row) => [row.credentialKind, row]));
    return CREDENTIAL_KINDS.map((kind) => {
      const row = byKind.get(kind);
      return row ? configuredSummary(kind, row) : missingSummary(kind);
    });
  }

  async getSummary(kind: CredentialKind): Promise<ServiceCredentialSummary> {
    const row = await this.find(kind);
    return row ? configuredSummary(kind, row) : missingSummary(kind);
  }

  async upsert(kind: CredentialKind, secret: string): Promise<ServiceCredentialSummary> {
    if (!secret.trim()) throw new CredentialStorageError();
    const encrypted = this.crypto.encrypt(secret);
    const lastFour = Array.from(secret).slice(-4).join("");
    try {
      await this.pool.execute<ResultSetHeader>(
        `INSERT INTO service_credentials
           (credential_kind, ciphertext, iv, auth_tag, last_four)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           ciphertext = VALUES(ciphertext), iv = VALUES(iv),
           auth_tag = VALUES(auth_tag), last_four = VALUES(last_four),
           updated_at = CURRENT_TIMESTAMP(3)`,
        [kind, encrypted.ciphertext, encrypted.iv, encrypted.authTag, lastFour]
      );
    } catch {
      throw new CredentialStorageError();
    }
    return this.getSummary(kind);
  }

  async getSecret(kind: CredentialKind): Promise<string | null> {
    const row = await this.find(kind);
    if (!row) return null;
    return this.crypto.decrypt({ ciphertext: row.ciphertext, iv: row.iv, authTag: row.authTag });
  }

  async delete(kind: CredentialKind): Promise<boolean> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      "DELETE FROM service_credentials WHERE credential_kind = ?",
      [kind]
    );
    return result.affectedRows === 1;
  }

  private async find(kind: CredentialKind): Promise<CredentialRow | null> {
    const [rows] = await this.pool.execute<CredentialRow[]>(
      `SELECT credential_kind AS credentialKind, ciphertext, iv,
              auth_tag AS authTag, last_four AS lastFour, updated_at AS updatedAt
       FROM service_credentials WHERE credential_kind = ? LIMIT 1`,
      [kind]
    );
    return rows[0] ?? null;
  }
}
