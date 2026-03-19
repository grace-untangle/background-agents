import { beforeEach, describe, expect, it, vi } from "vitest";
import { callbacksRouter } from "./callbacks";
import type { Env } from "./types";

const {
  mockExtractAgentResponse,
  mockPostMessage,
  mockRemoveReaction,
} = vi.hoisted(() => ({
  mockExtractAgentResponse: vi.fn(),
  mockPostMessage: vi.fn(),
  mockRemoveReaction: vi.fn(),
}));

vi.mock("./completion/extractor", () => ({
  extractAgentResponse: mockExtractAgentResponse,
}));

vi.mock("./utils/slack-client", () => ({
  postMessage: mockPostMessage,
  removeReaction: mockRemoveReaction,
}));

async function signPayload(payload: object, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signatureData = encoder.encode(JSON.stringify(payload));
  const sig = await crypto.subtle.sign("HMAC", key, signatureData);
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("callbacksRouter", () => {
  const secret = "test-secret";
  const env = {
    INTERNAL_CALLBACK_SECRET: secret,
    SLACK_BOT_TOKEN: "xoxb-test",
    WEB_APP_URL: "https://open-inspect-untangle.vercel.app",
  } as Env;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExtractAgentResponse.mockResolvedValue({
      textContent: "Hello from the agent",
      toolCalls: [],
      artifacts: [],
      success: true,
    });
    mockRemoveReaction.mockResolvedValue({ ok: true });
  });

  it("falls back to plain text when rich completion post is rejected", async () => {
    mockPostMessage
      .mockResolvedValueOnce({ ok: false, error: "invalid_blocks" })
      .mockResolvedValueOnce({ ok: true, ts: "12345.6789" });

    const payloadData = {
      sessionId: "session-1",
      messageId: "msg-1",
      success: true,
      timestamp: Date.now(),
      context: {
        source: "slack",
        channel: "C123",
        threadTs: "123.456",
        repoFullName: "snarktank/untangle",
        model: "anthropic/claude-haiku-4-5",
      },
    };

    const payload = {
      ...payloadData,
      signature: await signPayload(payloadData, secret),
    };

    const executionCtx = {
      waitUntil(promise: Promise<unknown>) {
        return promise;
      },
    };

    const response = await callbacksRouter.request("https://example.com/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }, env, executionCtx);

    expect(response.status).toBe(200);
    expect(mockPostMessage).toHaveBeenCalledTimes(2);
    expect(mockPostMessage).toHaveBeenNthCalledWith(
      1,
      "xoxb-test",
      "C123",
      "Hello from the agent",
      expect.objectContaining({
        thread_ts: "123.456",
        blocks: expect.any(Array),
      })
    );
    expect(mockPostMessage).toHaveBeenNthCalledWith(
      2,
      "xoxb-test",
      "C123",
      expect.stringContaining("View session: https://open-inspect-untangle.vercel.app/session/session-1"),
      { thread_ts: "123.456" }
    );
  });
});
