import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import app from "../src/index";

const request = (path: string, init?: RequestInit) =>
  app.request(`https://example.com${path}`, init, env);

describe("Worker", () => {
  it("reports service metadata", async () => {
    const response = await request("/");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      name: "not-quite-my-tempo-api",
      message: "Hono on Cloudflare Workers with D1 and Effect",
    });
  });

  it("reports health", async () => {
    const response = await request("/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });
});
