/// <reference types="node" />
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL as NodeURL, fileURLToPath } from "node:url";
import { reasonMessage, type ReasonCode, type TurnEvent, type TurnRequest } from "@niho/docs-core";
import type { TurnScript } from "./fake-bridge";

/**
 * 偽の claude（apps/docs/sidecar/fake/claude。実物のシェルスクリプト）を起動して、工程の実行を通す TurnScript。
 * 起動引数は crate の crates/local-ai/src/claude.rs と同じ形（システム側は --system-prompt-file、ユーザー側は標準入力）。
 * stdout の stream-json（JSONL）を TurnEvent に直す（crate の claude.rs の読み方の最小の写し）。
 */

// jsdom の環境では global の URL が jsdom のものになるので、node の URL で組む
const FAKE_CLAUDE = fileURLToPath(new NodeURL("../sidecar/fake/claude", import.meta.url));

type StreamLine = {
  type?: string;
  event?: { type?: string; delta?: { type?: string; text?: string; thinking?: string; stop_reason?: string } };
  is_error?: boolean;
  result?: string;
  session_id?: string;
  duration_ms?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
};

function errorEvent(code: ReasonCode): TurnEvent {
  return { type: "Error", reason_code: code, message: reasonMessage(code) };
}

function classifyResultError(text: string): ReasonCode {
  if (/hit your limit|usage limit/i.test(text)) return "UsageLimitReached";
  if (/log ?in/i.test(text)) return "CliLoginRequired";
  return "TransientFailure";
}

/** stream-json の行を TurnEvent に直す。result が無ければ壊れた出力。 */
export function claudeStreamToEvents(stdout: string): TurnEvent[] {
  const events: TurnEvent[] = [];
  let text = "";
  let stopReason: string | null = null;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let value: StreamLine;
    try {
      value = JSON.parse(line) as StreamLine;
    } catch {
      return [...events, errorEvent("InvalidStream")];
    }
    if (value.type === "stream_event") {
      const event = value.event;
      const delta = event?.delta;
      if (event?.type === "content_block_delta" && delta?.type === "text_delta" && typeof delta.text === "string") {
        text += delta.text;
        events.push({ type: "TextDelta", text: delta.text });
      } else if (event?.type === "content_block_delta" && delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
        events.push({ type: "ThinkingDelta", text: delta.thinking });
      } else if (event?.type === "message_delta" && typeof delta?.stop_reason === "string") {
        stopReason = delta.stop_reason;
      }
    } else if (value.type === "result") {
      if (value.is_error) return [...events, errorEvent(classifyResultError(value.result ?? ""))];
      events.push({
        type: "Done",
        text: text.trim() ? text : (value.result ?? ""),
        stop_reason: stopReason === "max_tokens" ? "MaxTokens" : "EndTurn",
        session_id: value.session_id ?? null,
        usage: {
          input_tokens: value.usage?.input_tokens ?? 0,
          output_tokens: value.usage?.output_tokens ?? 0,
          cost_usd: null,
          model_used: null,
          cost_known: false,
        },
        duration_ms: value.duration_ms ?? 0,
        continuations: 0,
      });
      return events;
    }
  }
  return [...events, errorEvent("InvalidStream")];
}

/** 依頼ごとに偽の claude を 1 回起動する（続きは `--resume <session>`）。 */
export function fakeClaude(): TurnScript {
  return (request: TurnRequest) => {
    const dir = mkdtempSync(join(tmpdir(), "niho-docs-fake-claude-"));
    try {
      const systemPromptFile = join(dir, "system-prompt.md");
      writeFileSync(systemPromptFile, request.system_prompt);
      const args = ["-p", "--output-format", "stream-json", "--verbose", "--system-prompt-file", systemPromptFile];
      if (request.model.trim()) args.push("--model", request.model.trim());
      if (request.resume_session) args.push("--resume", request.resume_session);
      else args.push("--session-id", randomUUID());
      const child = spawnSync(FAKE_CLAUDE, args, {
        input: request.user_prompt,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "en_US.UTF-8" },
        timeout: 30_000,
      });
      if (child.error || child.status !== 0) return [errorEvent("Unreachable")];
      return claudeStreamToEvents(child.stdout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
