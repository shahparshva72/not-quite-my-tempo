import { Data, Effect } from "effect";

/**
 * Encrypts GitHub user tokens at rest with AES-256-GCM. The key is the
 * TOKEN_ENCRYPTION_KEY Worker secret (32 random bytes, base64). Each value
 * gets a fresh 12-byte IV, and `context` (e.g. "user:12") is bound as
 * additional authenticated data so a ciphertext copied onto another user's
 * session fails to decrypt. Format: "v1.<iv base64>.<ciphertext base64>".
 */
export class TokenCipherError extends Data.TaggedError("TokenCipherError")<{
  readonly reason: "invalid_key" | "encrypt_failed" | "decrypt_failed";
}> {}

const VERSION = "v1";

const textEncoder = new TextEncoder();

const fromBase64 = (value: string) =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

const toBase64 = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));

const importKey = (base64Key: string | undefined) =>
  Effect.gen(function* () {
    const raw = yield* Effect.try({
      try: () => fromBase64(base64Key ?? ""),
      catch: () => new TokenCipherError({ reason: "invalid_key" }),
    });

    if (raw.byteLength !== 32) {
      return yield* new TokenCipherError({ reason: "invalid_key" });
    }

    return yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
          "encrypt",
          "decrypt",
        ]),
      catch: () => new TokenCipherError({ reason: "invalid_key" }),
    });
  });

export const encryptToken = (
  base64Key: string | undefined,
  token: string,
  context: string,
) =>
  Effect.gen(function* () {
    const key = yield* importKey(base64Key);
    const iv = crypto.getRandomValues(new Uint8Array(12));

    const ciphertext = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv,
            additionalData: textEncoder.encode(context),
          },
          key,
          textEncoder.encode(token),
        ),
      catch: () => new TokenCipherError({ reason: "encrypt_failed" }),
    });

    return `${VERSION}.${toBase64(iv)}.${toBase64(new Uint8Array(ciphertext))}`;
  });

export const decryptToken = (
  base64Key: string | undefined,
  value: string,
  context: string,
) =>
  Effect.gen(function* () {
    const key = yield* importKey(base64Key);
    const [version, iv, ciphertext] = value.split(".");

    if (version !== VERSION || iv === undefined || ciphertext === undefined) {
      return yield* new TokenCipherError({ reason: "decrypt_failed" });
    }

    const plaintext = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: fromBase64(iv),
            additionalData: textEncoder.encode(context),
          },
          key,
          fromBase64(ciphertext),
        ),
      catch: () => new TokenCipherError({ reason: "decrypt_failed" }),
    });

    return new TextDecoder().decode(plaintext);
  });

export const tokenContext = (userId: number) => `user:${userId}`;
