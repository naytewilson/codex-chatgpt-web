import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { ProviderAdapter } from "../src/adapters/base";
import {
  extractChatGptTurnEnvironment,
  extractChatGptTurnIdentity,
} from "../src/adapters/chatgpt-web/environment";
import { defaultConfig } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import { responseRequest } from "../src/server";
import type { CodexParsedRequest } from "../src/types";

const root = resolve(process.cwd());
const threadId = "thread_gateway_0123456789abcdef0123456789abcdef";
const turnId = "turn_gateway_fedcba9876543210fedcba9876543210";

function metadata(sandbox: "read-only" | "workspace-write" = "read-only") {
  return JSON.stringify({
    thread_id: threadId,
    turn_id: turnId,
    request_kind: "turn",
    sandbox,
    workspaces: { [root]: {} },
  });
}

function readOnlyEnvironment(): string {
  return `<environment_context>
  <cwd>${root}</cwd>
  <filesystem><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="managed"><file_system type="restricted"><entry access="read"><special>:root</special></entry></file_system></permission_profile></filesystem>
</environment_context>`;
}

function gatewayInitialBody(): Record<string, unknown> {
  const itemMetadata = { turn_id: turnId };
  return {
    model: "chatgpt-web/high",
    input: [
      {
        type: "message",
        id: "msg_gateway_environment_0123456789abcdef",
        role: "user",
        content: [{ type: "input_text", text: readOnlyEnvironment() }],
        internal_chat_message_metadata_passthrough: itemMetadata,
      },
      {
        type: "message",
        id: "msg_gateway_user_0123456789abcdef",
        role: "user",
        content: [{ type: "input_text", text: "Inspect the workspace" }],
        internal_chat_message_metadata_passthrough: itemMetadata,
      },
    ],
    tools: [{
      type: "function",
      name: "echo_value",
      description: "echo a value",
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
    }],
    parallel_tool_calls: true,
    stream: false,
    store: false,
    prompt_cache_key: threadId,
    client_metadata: { "x-codex-turn-metadata": metadata() },
  };
}

function jsonRequest(body: Record<string, unknown>): Request {
  return new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Local Agent Gateway outer-runtime contract", () => {
  test("accepts the exact Gateway-owned read-only turn envelope without weakening trust parsing", () => {
    const parsed = parseRequest(gatewayInitialBody());

    expect(extractChatGptTurnIdentity(parsed)).toMatchObject({
      threadId,
      turnId,
    });
    expect(extractChatGptTurnEnvironment(parsed)).toEqual({
      cwd: root,
      roots: [root],
      writableRoots: [],
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      tools: [{
        name: "echo_value",
        description: "echo a value",
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
      }],
    });
  });

  test("responseRequest force-replays a Gateway tool continuation on the same trusted browser turn", async () => {
    const config = defaultConfig("browser-only");
    const parsedRequests: CodexParsedRequest[] = [];
    let runCount = 0;

    const adapter: ProviderAdapter = {
      name: "gateway-outer-runtime-test",
      async runTurn(parsed, _incoming, emit) {
        parsedRequests.push(parsed);
        runCount += 1;
        if (runCount === 1) {
          emit({ type: "tool_call_start", id: "wire_call_1", name: "echo_value" });
          emit({ type: "tool_call_delta", arguments: "{\"value\":\"x\"}" });
          emit({ type: "tool_call_end" });
          emit({ type: "done", endTurn: false, stopReason: "tool_use" });
          return;
        }
        emit({ type: "text_delta", text: "done", phase: "final_answer" });
        emit({ type: "done", endTurn: true });
      },
    };

    const firstResponse = await responseRequest(
      jsonRequest(gatewayInitialBody()),
      config,
      () => adapter,
    );
    expect(firstResponse.status).toBe(200);
    const firstJSON = await firstResponse.json() as {
      id: string;
      status: string;
      output: Array<Record<string, unknown>>;
    };
    expect(firstJSON.status).toBe("completed");
    expect(firstJSON.id).toMatch(/^resp_/);
    const functionCall = firstJSON.output.find(item => item.type === "function_call");
    expect(functionCall).toMatchObject({
      type: "function_call",
      call_id: "wire_call_1",
      name: "echo_value",
      arguments: "{\"value\":\"x\"}",
      status: "completed",
    });
    expect(parsedRequests).toHaveLength(1);
    expect(extractChatGptTurnEnvironment(parsedRequests[0]!)).toMatchObject({
      cwd: root,
      roots: [root],
      writableRoots: [],
      sandboxPolicy: { type: "readOnly" },
    });

    const continuation = {
      model: "chatgpt-web/high",
      previous_response_id: firstJSON.id,
      input: [{
        type: "function_call_output",
        call_id: "wire_call_1",
        output: "OUT",
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      }],
      tools: (gatewayInitialBody().tools as unknown[]),
      parallel_tool_calls: true,
      stream: false,
      store: false,
      prompt_cache_key: threadId,
      client_metadata: { "x-codex-turn-metadata": metadata() },
    };

    const secondResponse = await responseRequest(
      jsonRequest(continuation),
      config,
      () => adapter,
    );
    expect(secondResponse.status).toBe(200);
    const secondJSON = await secondResponse.json() as {
      status: string;
      end_turn?: boolean;
      output: Array<Record<string, unknown>>;
    };
    expect(secondJSON.status).toBe("completed");
    expect(secondJSON.end_turn).toBe(true);
    expect(secondJSON.output).toContainEqual(expect.objectContaining({
      type: "message",
      role: "assistant",
      content: [expect.objectContaining({ type: "output_text", text: "done" })],
    }));

    expect(runCount).toBe(2);
    expect(parsedRequests).toHaveLength(2);
    expect(parsedRequests[1]!.previousResponseId).toBe(firstJSON.id);
    expect(extractChatGptTurnIdentity(parsedRequests[1]!)).toMatchObject({ threadId, turnId });
    expect(extractChatGptTurnEnvironment(parsedRequests[1]!)).toMatchObject({
      cwd: root,
      roots: [root],
      writableRoots: [],
      sandboxPolicy: { type: "readOnly" },
    });
    const toolResult = parsedRequests[1]!.context.messages.find(message => message.role === "toolResult");
    expect(toolResult).toMatchObject({
      role: "toolResult",
      toolCallId: "wire_call_1",
      toolName: "echo_value",
      content: "OUT",
    });
  });
});
