import { Effect, Schema } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

import {
  createAppJwt,
  GitHubAppAuth,
  GitHubAppAuthLive,
} from "../src/github/app-auth";

const JwtPayload = Schema.Struct({
  iat: Schema.Number,
  exp: Schema.Number,
  iss: Schema.String,
});

const base64UrlDecode = (segment: string) => {
  const base64 = segment.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
};

const derToPem = (der: ArrayBuffer) => {
  const bytes = new Uint8Array(der);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  const base64 = btoa(binary);
  const lines = base64.match(/.{1,64}/g) ?? [];

  return [
    "-----BEGIN PRIVATE KEY-----",
    ...lines,
    "-----END PRIVATE KEY-----",
  ].join("\n");
};

let privateKeyPem = "";

let publicKey: CryptoKey;

beforeAll(async () => {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );

  privateKeyPem = derToPem(
    await crypto.subtle.exportKey("pkcs8", keyPair.privateKey),
  );
  publicKey = keyPair.publicKey;
});

describe("createAppJwt", () => {
  it("produces a verifiable RS256 JWT with GitHub App claims", async () => {
    const before = Math.floor(Date.now() / 1000);
    const jwt = await Effect.runPromise(createAppJwt("12345", privateKeyPem));
    const after = Math.floor(Date.now() / 1000);

    const segments = jwt.split(".");
    expect(segments).toHaveLength(3);
    const [headerSegment, payloadSegment, signatureSegment] = segments;

    const header = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(headerSegment ?? "")),
    );

    expect(header).toEqual({ alg: "RS256", typ: "JWT" });

    const payload = Schema.decodeUnknownSync(Schema.parseJson(JwtPayload))(
      new TextDecoder().decode(base64UrlDecode(payloadSegment ?? "")),
    );

    expect(payload.iss).toBe("12345");
    expect(payload.iat).toBeGreaterThanOrEqual(before - 60);
    expect(payload.iat).toBeLessThanOrEqual(after - 60);
    expect(payload.exp - payload.iat).toBe(600);
    expect(payload.exp - after).toBeLessThanOrEqual(600);

    const verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      base64UrlDecode(signatureSegment ?? ""),
      new TextEncoder().encode(`${headerSegment}.${payloadSegment}`),
    );

    expect(verified).toBe(true);
  });

  it("rejects a PKCS#1 private key with a conversion hint", async () => {
    const pkcs1Pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "irrelevant",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");

    const error = await Effect.runPromise(
      Effect.flip(createAppJwt("12345", pkcs1Pem)),
    );

    expect(error._tag).toBe("GitHubAppJwtError");
    expect(error.message).toContain("PKCS#8");
  });
});

describe("GitHubAppAuth.mintInstallationToken", () => {
  const mintWith = (fetchImpl: typeof fetch) =>
    Effect.gen(function* () {
      const auth = yield* GitHubAppAuth;

      return yield* auth.mintInstallationToken(987);
    }).pipe(
      Effect.provide(
        GitHubAppAuthLive({
          appId: "12345",
          privateKey: privateKeyPem,
          baseUrl: "https://github.test",
          fetchImpl,
        }),
      ),
    );

  it("exchanges an app JWT for an installation token", async () => {
    const requests: { url: string; init: RequestInit | undefined }[] = [];

    const fetchImpl: typeof fetch = (input, init) => {
      requests.push({ url: String(input), init });

      return Promise.resolve(
        new Response(
          JSON.stringify({
            token: "ghs_testtoken",
            expires_at: "2026-09-13T12:00:00Z",
          }),
          { status: 201 },
        ),
      );
    };

    const result = await Effect.runPromise(mintWith(fetchImpl));

    expect(result.token).toBe("ghs_testtoken");
    expect(result.expiresAt).toEqual(new Date("2026-09-13T12:00:00Z"));

    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request?.url).toBe(
      "https://github.test/app/installations/987/access_tokens",
    );
    expect(request?.init?.method).toBe("POST");

    const headers = new Headers(request?.init?.headers);
    expect(headers.get("authorization")).toMatch(/^Bearer [\w-]+\.[\w-]+\./);
    expect(headers.get("accept")).toBe("application/vnd.github+json");
    expect(headers.get("x-github-api-version")).toBe("2022-11-28");
  });

  it("fails with the response status and body on a non-2xx response", async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ message: "Bad credentials" }), {
          status: 401,
        }),
      );

    const error = await Effect.runPromise(Effect.flip(mintWith(fetchImpl)));

    expect(error._tag).toBe("GitHubInstallationTokenError");
    expect(error).toMatchObject({
      status: 401,
      body: JSON.stringify({ message: "Bad credentials" }),
    });
  });

  it("fails when the response body does not match the token schema", async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ unexpected: true }), { status: 201 }),
      );

    const error = await Effect.runPromise(Effect.flip(mintWith(fetchImpl)));

    expect(error._tag).toBe("GitHubApiRequestError");
  });
});
