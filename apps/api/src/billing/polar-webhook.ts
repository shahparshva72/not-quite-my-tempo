import { Data, Effect, Option, Schema } from "effect";

// Polar signs webhooks with the Standard Webhooks scheme: HMAC-SHA256 over
// "<webhook-id>.<webhook-timestamp>.<body>", keyed with the base64 bytes
// after the "whsec_" prefix, sent as space-separated "v1,<base64>" entries.
// https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md

/** Deliveries older or newer than this are refused as replays. */
const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

export interface PolarWebhookHeaders {
  readonly id: string | undefined;
  readonly timestamp: string | undefined;
  readonly signature: string | undefined;
}

const secretBytes = (secret: string) =>
  Schema.decodeUnknownOption(Schema.Uint8ArrayFromBase64)(
    secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret,
  ).pipe(Option.filter((bytes) => bytes.length > 0));

const signatures = (header: string) =>
  header.split(" ").flatMap((entry) => {
    const [version, value] = entry.split(",");

    return version === "v1" && value !== undefined
      ? Option.toArray(
          Schema.decodeUnknownOption(Schema.Uint8ArrayFromBase64)(value),
        )
      : [];
  });

/** Whether the delivery is signed with the secret and fresh. */
export const verifyPolarWebhook = (
  body: string,
  headers: PolarWebhookHeaders,
  secret: string,
  now: Date,
) =>
  Effect.gen(function* () {
    const { id, timestamp, signature } = headers;
    const key = secretBytes(secret);

    if (
      id === undefined ||
      timestamp === undefined ||
      signature === undefined ||
      Option.isNone(key) ||
      !/^\d{1,12}$/.test(timestamp) ||
      Math.abs(now.getTime() / 1000 - Number(timestamp)) >
        TIMESTAMP_TOLERANCE_SECONDS
    ) {
      return false;
    }

    const candidates = signatures(signature);

    if (candidates.length === 0) {
      return false;
    }

    const cryptoKey = yield* Effect.promise(() =>
      crypto.subtle.importKey(
        "raw",
        new Uint8Array(key.value),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      ),
    );

    const signed = new TextEncoder().encode(`${id}.${timestamp}.${body}`);

    // crypto.subtle.verify compares in constant time.
    const results = yield* Effect.forEach(candidates, (candidate) =>
      Effect.promise(() =>
        crypto.subtle.verify(
          "HMAC",
          cryptoKey,
          new Uint8Array(candidate),
          signed,
        ),
      ),
    );

    return results.some(Boolean);
  });

const WorkspaceIdFromMetadata = Schema.Union(
  Schema.NumberFromString,
  Schema.Number,
).pipe(Schema.int(), Schema.positive());

const PolarEvent = Schema.Struct({
  type: Schema.String,
  data: Schema.Unknown,
});

const SubscriptionPayload = Schema.Struct({
  id: Schema.String,
  metadata: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
});

/**
 * What a verified delivery asks Fletcher to do. A subscription event only
 * says which workspace to re-read from Polar; its payload is never trusted
 * as the current state, so late or out-of-order deliveries can't roll a
 * plan back.
 */
export type PolarWebhookEvent = Data.TaggedEnum<{
  SyncWorkspace: {
    readonly workspaceId: number;
    readonly eventType: string;
    readonly subscriptionId: string;
  };
  // Not a subscription event, or a subscription Fletcher's checkout
  // didn't create (no workspace_id in its metadata).
  Ignore: { readonly eventType: string };
  // A body that isn't a Polar event, or a subscription event whose shape
  // changed. Worth an alert: plan updates would silently stop.
  Malformed: { readonly eventType: string };
}>;

export const PolarWebhookEvent = Data.taggedEnum<PolarWebhookEvent>();

export const decodePolarWebhookEvent = (body: string): PolarWebhookEvent =>
  Option.match(Schema.decodeUnknownOption(Schema.parseJson(PolarEvent))(body), {
    onNone: () => PolarWebhookEvent.Malformed({ eventType: "unknown" }),
    onSome: ({ type: eventType, data }) =>
      !eventType.startsWith("subscription.")
        ? PolarWebhookEvent.Ignore({ eventType })
        : Option.match(Schema.decodeUnknownOption(SubscriptionPayload)(data), {
            onNone: () => PolarWebhookEvent.Malformed({ eventType }),
            onSome: (subscription) =>
              Option.match(
                Schema.decodeUnknownOption(WorkspaceIdFromMetadata)(
                  subscription.metadata["workspace_id"],
                ),
                {
                  onNone: () => PolarWebhookEvent.Ignore({ eventType }),
                  onSome: (workspaceId) =>
                    PolarWebhookEvent.SyncWorkspace({
                      workspaceId,
                      eventType,
                      subscriptionId: subscription.id,
                    }),
                },
              ),
          }),
  });
