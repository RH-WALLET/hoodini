/**
 * @hoodini/core/keystore — client-side key custody.
 *
 * There is no export here that transmits, uploads, or persists a key anywhere
 * but the caller's own storage (CLAUDE.md invariant 1).
 */

export type { EncryptedVault, VaultSet, KdfParams, UnlockedAccount } from './types.js';
export { KeystoreError } from './types.js';
export {
  createVault,
  createRandomVault,
  unlockVault,
  exportPrivateKey,
  changePassword,
  generatePrivateKey,
  wipe,
  DEFAULT_KDF,
  TEST_KDF,
} from './vault.js';
export { KeystoreSession, DEFAULT_AUTO_LOCK_MS, type SessionOptions } from './session.js';
