import { Data, Effect, Option, Schema, SchemaTransformation } from "effect";

const GitHubSignatureHex = Schema.String.check(
  Schema.isPattern(/^sha256=[0-9a-f]{64}$/i),
).pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({
      decode: (signature) => signature.slice("sha256=".length),
      encode: (hex) => `sha256=${hex}`,
    }),
  ),
  Schema.decodeTo(Schema.Uint8ArrayFromHex),
);

export class SignatureVerificationError extends Data.TaggedError(
  "SignatureVerificationError",
)<{
  readonly cause: unknown;
}> {}

export const verifyGitHubWebhookSignature = (
  rawBody: ArrayBuffer,
  signatureHeader: string | undefined,
  secret: string,
): Effect.Effect<boolean, SignatureVerificationError> =>
  Effect.gen(function* () {
    const signature = yield* Schema.decodeUnknownEffect(GitHubSignatureHex)(
      signatureHeader,
    ).pipe(Effect.option);

    const webhookSecret = yield* Schema.decodeUnknownEffect(
      Schema.NonEmptyString,
    )(secret).pipe(Effect.option);

    return yield* Option.match(Option.all({ signature, webhookSecret }), {
      onNone: () => Effect.succeed(false),
      onSome: ({ signature: signatureBytes, webhookSecret: secretValue }) =>
        Effect.gen(function* () {
          const key = yield* Effect.tryPromise({
            try: () =>
              crypto.subtle.importKey(
                "raw",
                new TextEncoder().encode(secretValue),
                { name: "HMAC", hash: "SHA-256" },
                false,
                ["verify"],
              ),
            catch: (cause) => new SignatureVerificationError({ cause }),
          });

          return yield* Effect.tryPromise({
            try: () =>
              crypto.subtle.verify(
                "HMAC",
                key,
                new Uint8Array(signatureBytes),
                rawBody,
              ),
            catch: (cause) => new SignatureVerificationError({ cause }),
          });
        }),
    });
  });
