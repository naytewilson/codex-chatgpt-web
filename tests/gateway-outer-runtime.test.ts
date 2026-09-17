import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  extractChatGptTurnEnvironment,
  extractChatGptTurnIdentity,
} from "../src/adapters/chatgpt-web/environment";
import { parseRequest } from "../src/responses/parser";
import {
  expandPreviousResponseInput,
  rememberResponseState,
} from "../src/responses/state";

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
      sandboxPolicy: { type: "readOnly" },
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

  test("replays a Gateway tool continuation under the same trusted browser turn", () => {
    const initial = gatewayInitialBody();
    rememberResponseState(initial, {
      id: "resp_gateway_outer_runtime_1",
      status: "completed",
      output: [{
        id: "fc_gateway_outer_runtime_1",
        type: "function_call",
        status: "completed",
        call_id: "wire_call_1",
        name: "echo_value",
        arguments: "{\"value\":\"x\"}",
      }],
    }, { force: true });

    const continuation = {
      model: "chatgpt-web/high",
      previous_response_id: "resp_gateway_outer_runtime_1",
      input: [{
        type: "function_call_output",
        call_id: "wire_call_1",
        output: "OUT",
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      }],
      tools: (initial.tools as unknown[]),
      parallel_tool_calls: true,
      stream: false,
      store: false,
      prompt_cache_key: threadId,
      client_metadata: { "x-codex-turn-metadata": metadata() },
    };

    const expanded = expandPreviousResponseInput(continuation);
    const parsed = parseRequest(expanded);

    expect(parsed.previousResponseId).toBe("resp_gateway_outer_runtime_1");
    expect(extractChatGptTurnIdentity(parsed)).toMatchObject({ threadId, turnId });
    expect(extractChatGptTurnEnvironment(parsed)).toMatchObject({
      cwd: root,
      roots: [root],
      writableRoots: [],
      sandboxPolicy: { type: "readOnly" },
    });
    const toolResult = parsed.context.messages.find(message => message.role === "toolResult");
    expect(toolResult).toMatchObject({
      role: "toolResult",
      toolCallId: "wire_call_1",
      toolName: "echo_value",
      content: "OUT",
    });
  });
});
