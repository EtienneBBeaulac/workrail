import type { ResultAsync } from 'neverthrow';

export interface KeyringV1 {
  readonly v: 1;
  readonly current: { readonly alg: 'hmac_sha256'; readonly keyBase64Url: string };
  readonly previous: { readonly alg: 'hmac_sha256'; readonly keyBase64Url: string } | null;
}

export type KeyringError =
  | { readonly code: 'KEYRING_IO_ERROR'; readonly message: string }
  | { readonly code: 'KEYRING_CORRUPTION_DETECTED'; readonly message: string }
  | { readonly code: 'KEYRING_INVARIANT_VIOLATION'; readonly message: string };

export interface KeyringPortV2 {
  loadOrCreate(): ResultAsync<KeyringV1, KeyringError>;
  rotate(): ResultAsync<KeyringV1, KeyringError>;
}
