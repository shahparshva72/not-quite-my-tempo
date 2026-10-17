/**
 * A local OpenAI Chat Completions endpoint backed by Gemini on Vertex AI,
 * so Martian's benchmark pipeline (which speaks the OpenAI API) can judge
 * on Vertex credits with the same API key the reviews use. See README.md.
 *
 * Two deliberate departures from Martian's requests: the temperature is
 * dropped (Google warns Gemini 3+ below 1.0 can loop or reason worse), and
 * thinking runs at JUDGE_THINKING_LEVEL ("low" unless set) because the
 * judge's yes/no matching doesn't need more and thinking is billed as
 * output.
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { Schema } from "effect";
import {
  findCatalogModel,
  reviewCostUsdMicros,
  VERTEX_API_BASE_URL,
} from "@not-quite-my-tempo/reviewer";

const ChatRequest = Schema.Struct({
  model: Schema.String,
  messages: Schema.Array(
    Schema.Struct({
      role: Schema.Literal("system", "user", "assistant"),
      content: Schema.String,
    }),
  ),
});

type ChatRequest = typeof ChatRequest.Type;

const VertexReply = Schema.Struct({
  candidates: Schema.optional(
    Schema.Array(
      Schema.Struct({
        content: Schema.optional(
          Schema.Struct({
            parts: Schema.optional(
              Schema.Array(
                Schema.Struct({ text: Schema.optional(Schema.String) }),
              ),
            ),
          }),
        ),
        finishReason: Schema.optional(Schema.String),
      }),
    ),
  ),
  usageMetadata: Schema.optional(
    Schema.Struct({
      promptTokenCount: Schema.optional(Schema.Number),
      cachedContentTokenCount: Schema.optional(Schema.Number),
      totalTokenCount: Schema.optional(Schema.Number),
    }),
  ),
});

const ThinkingLevel = Schema.Literal("minimal", "low", "medium", "high");

const apiKey = process.env["VERTEX_API_KEY"];

if (apiKey === undefined) {
  console.error("VERTEX_API_KEY is not set.");
  process.exit(1);
}

const port = Number(process.env["JUDGE_PROXY_PORT"] ?? "8788");

const thinkingLevel = Schema.decodeUnknownSync(ThinkingLevel)(
  process.env["JUDGE_THINKING_LEVEL"] ?? "low",
);

const totals = { calls: 0, failures: 0, input: 0, output: 0, cached: 0 };

const costUsd = (model: string) => {
  const catalogModel = findCatalogModel(model);

  return catalogModel === undefined
    ? "unknown (model not in the catalog)"
    : `$${(
        reviewCostUsdMicros(
          catalogModel,
          totals.input,
          totals.output,
          totals.cached,
        ) / 1_000_000
      ).toFixed(4)}`;
};

let lastModel = "";

const printTotals = () =>
  console.log(
    `${totals.calls} calls (${totals.failures} failed), ${totals.input} input / ${totals.output} output tokens, ${costUsd(lastModel)}`,
  );

const readBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
};

const sendJson = (
  response: ServerResponse,
  status: number,
  body:
    | Record<string, Readonly<Record<string, string | number>>>
    | ChatCompletion,
) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

interface ChatCompletion {
  readonly id: string;
  readonly object: "chat.completion";
  readonly created: number;
  readonly model: string;
  readonly choices: readonly {
    readonly index: number;
    readonly message: { readonly role: "assistant"; readonly content: string };
    readonly finish_reason: string;
  }[];
  readonly usage: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly total_tokens: number;
  };
}

const vertexRequestBody = (chat: ChatRequest) => {
  const system = chat.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");

  // Martian's prompts always carry a system message.
  return JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: chat.messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: message.content }],
      })),
    // Every Martian prompt asks for a bare JSON object.
    generationConfig: {
      responseMimeType: "application/json",
      thinkingConfig: { thinkingLevel },
    },
  });
};

const handleCompletion = async (
  request: IncomingMessage,
  response: ServerResponse,
) => {
  const chat = Schema.decodeUnknownSync(Schema.parseJson(ChatRequest))(
    await readBody(request),
  );

  lastModel = chat.model;

  const vertex = await fetch(
    `${VERTEX_API_BASE_URL}/v1/publishers/google/models/${chat.model}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: vertexRequestBody(chat),
    },
  );

  const text = await vertex.text();

  if (!vertex.ok) {
    totals.failures += 1;
    console.error(`Vertex ${vertex.status}: ${text.slice(0, 300)}`);
    // The OpenAI client retries 429s and 5xx when it sees the same status.
    sendJson(response, vertex.status, {
      error: { message: text.slice(0, 2_000), code: vertex.status },
    });

    return;
  }

  const reply = Schema.decodeUnknownSync(Schema.parseJson(VertexReply))(text);
  const candidate = reply.candidates?.[0];

  const content = (candidate?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("");

  const input = reply.usageMetadata?.promptTokenCount ?? 0;
  // Thinking is billed as output but reported outside candidatesTokenCount.
  const output = (reply.usageMetadata?.totalTokenCount ?? input) - input;

  totals.calls += 1;
  totals.input += input;
  totals.output += output;
  totals.cached += reply.usageMetadata?.cachedContentTokenCount ?? 0;

  if (totals.calls % 50 === 0) {
    printTotals();
  }

  sendJson(response, 200, {
    id: `judge-${totals.calls}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1_000),
    model: chat.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason:
          candidate?.finishReason === "MAX_TOKENS" ? "length" : "stop",
      },
    ],
    usage: {
      prompt_tokens: input,
      completion_tokens: output,
      total_tokens: input + output,
    },
  });
};

const server = createServer((request, response) => {
  if (
    request.method !== "POST" ||
    !(request.url ?? "").endsWith("/chat/completions")
  ) {
    sendJson(response, 404, {
      error: { message: "Only POST /v1/chat/completions is served." },
    });

    return;
  }

  handleCompletion(request, response).catch((error: Error) => {
    totals.failures += 1;
    console.error(`Proxy error: ${error.message}`);
    sendJson(response, 500, { error: { message: error.message } });
  });
});

process.on("SIGINT", () => {
  printTotals();
  process.exit(0);
});

server.listen(port, "127.0.0.1", () =>
  console.log(
    `Judge proxy on http://127.0.0.1:${port}/v1 (thinking ${thinkingLevel}). Ctrl-C prints the bill.`,
  ),
);
