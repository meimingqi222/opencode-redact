/**
 * OpenCode Plugin: opencode-redact
 *
 * Automatically redacts API keys, tokens, passwords and other secrets from
 * all data sent to LLMs before they leave your machine.
 *
 * Usage in opencode.json:
 *   { "plugin": ["opencode-redact"] }
 *
 * Or for local development:
 *   Put this file in .opencode/plugins/redact.ts
 */

import type { Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin";
import { redact, redactDeep, redactStringValue, redactByPaths, type SecretPattern } from "./engine.js";
import { SECRET_PATTERNS } from "./patterns.js";

export interface RedactPluginOptions extends PluginOptions {
  /** Disable the plugin entirely */
  disabled?: boolean;
  /** Additional secret patterns to detect */
  extraPatterns?: SecretPattern[];
  /** Path-based redaction (e.g. ["token", "users[*].password"]) */
  redactPaths?: string[];
  /** Censor string for path redaction (default: "[REDACTED]") */
  pathCensor?: string;
}

const DEFAULT_OPTIONS: RedactPluginOptions = {
  disabled: false,
  extraPatterns: [],
  redactPaths: [],
  pathCensor: "[REDACTED]",
};

export const RedactPlugin: Plugin = async (
  input: PluginInput,
  options?: RedactPluginOptions,
) => {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  if (opts.disabled) {
    input.client.app.log({
      body: { service: "opencode-redact", level: "info", message: "Plugin disabled via config" },
    });
    return {};
  }

  let patterns = [...SECRET_PATTERNS, ...(opts.extraPatterns ?? [])];
  const redactPaths = opts.redactPaths ?? [];
  const pathCensor = opts.pathCensor ?? "[REDACTED]";

  input.client.app.log({
    body: {
      service: "opencode-redact",
      level: "info",
      message: `Plugin initialized with ${patterns.length} secret patterns and ${redactPaths.length} path rules`,
    },
  });

  // Warm up regex compilation
  for (const p of patterns) {
    try {
      p._regex = new RegExp(p.pattern, p.caseInsensitive ? "gi" : "g");
    } catch { /* ignored — will be retried on first use */ }
  }

  let redactionCount = 0;

  return {
    dispose: async () => {
      input.client.app.log({
        body: {
          service: "opencode-redact",
          level: "info",
          message: `Plugin disposed. Total redactions: ${redactionCount}`,
        },
      });
    },

    /**
     * Hook: redact user message content and parts before processing.
     */
    "chat.message": async (_hookInput, output) => {
      const cache = new Map<string, string>();

      // Redact parts (text content)
      if (output.parts) {
        for (const part of output.parts) {
          if (part.type === "text" && typeof part.text === "string") {
            const original = part.text;
            (part as Record<string, unknown>).text = redactStringValue(original, patterns, cache) ?? original;
            if ((part as Record<string, unknown>).text !== original) redactionCount++;
          }
        }
      }

      // UserMessage data is in parts, already handled above
    },

    /**
     * Hook: redact tool input arguments before execution.
     */
    "tool.execute.before": async (_hookInput, output) => {
      if (output.args) {
        const cache = new Map<string, string>();
        output.args = redactDeep(output.args, patterns, cache) as Record<string, unknown>;
      }
    },

    /**
     * Hook: redact tool output after execution.
     */
    "tool.execute.after": async (_hookInput, output) => {
      const cache = new Map<string, string>();

      if (typeof output.output === "string") {
        output.output = redactStringValue(output.output, patterns, cache) ?? output.output;
      }

      if (output.metadata) {
        output.metadata = redactDeep(output.metadata, patterns, cache);
      }

      // Apply path-based redaction
      if (redactPaths.length > 0 && output.metadata) {
        output.metadata = redactByPaths(output.metadata, redactPaths, pathCensor);
      }
    },

    /**
     * Hook: transform ALL messages in the history before sending to LLM.
     * This is the critical hook that ensures secrets are redacted from
     * the entire conversation context (including assistant responses,
     * tool results, and historical messages).
     */
    "experimental.chat.messages.transform": async (_hookInput, output) => {
      const cache = new Map<string, string>();

      if (output.messages) {
        for (let i = 0; i < output.messages.length; i++) {
          const msg = output.messages[i];

          // Redact message info
          if (msg.info) {
            msg.info = redact(msg.info, patterns) as typeof msg.info;
          }

          // Redact all parts
          if (msg.parts) {
            for (const part of msg.parts) {
              if (part.type === "text" && typeof part.text === "string") {
                const original = part.text;
                (part as Record<string, unknown>).text =
                  redactStringValue(original, patterns, cache) ?? original;
                if ((part as Record<string, unknown>).text !== original) redactionCount++;
              }
              // Redact tool parts (input args + output)
              if (part.type === "tool") {
                const toolPart = part as Record<string, unknown>;
                const state = toolPart.state as Record<string, unknown> | undefined;
                if (state && typeof state === "object") {
                  if (state.input && typeof state.input === "object") {
                    state.input = redactDeep(state.input, patterns, cache);
                  }
                  if (typeof state.output === "string") {
                    state.output = redactStringValue(state.output, patterns, cache) ?? state.output;
                  }
                }
              }
              // Redact reasoning content (model thinking)
              if (part.type === "reasoning" && typeof (part as Record<string, unknown>).text === "string") {
                const rPart = part as Record<string, unknown>;
                const original = rPart.text as string;
                rPart.text = redactStringValue(original, patterns, cache) ?? original;
              }
            }
          }
        }
      }
    },

    /**
     * Hook: handle enable/disable toggle
     */
    event: async ({ event }) => {
      if (
        event.type === "command.executed" &&
        event.properties?.name === "redact:toggle"
      ) {
        opts.disabled = !opts.disabled;
        input.client.app.log({
          body: {
            service: "opencode-redact",
            level: "info",
            message: `Plugin ${opts.disabled ? "disabled" : "enabled"}`,
          },
        });
      }
    },
  };
};
