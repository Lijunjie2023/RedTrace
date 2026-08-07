export const CREDENTIAL_KINDS = ["JUSTONEAPI", "DEEPSEEK"] as const;

export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

export interface EncryptedCredential {
  ciphertext: string;
  iv: string;
  authTag: string;
}

export interface ServiceCredentialSummary {
  kind: CredentialKind;
  configured: boolean;
  lastFour: string | null;
  updatedAt: string | null;
}
