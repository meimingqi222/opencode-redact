import { describe, expect, test } from "bun:test";
import {
  stripInvisibleUnicode,
  redactStringValue,
  redactDeep,
  redact,
  redactByPaths,
  type SecretPattern,
} from "./engine";

const TEST_PATTERNS: SecretPattern[] = [
  {
    id: "test-api-key",
    category: "test",
    title: "Test API Key",
    pattern: String.raw`(sk-test-[a-zA-Z0-9]{32})`,
    keywords: ["sk-test-"],
    caseInsensitive: true,
  },
  {
    id: "test-password",
    category: "test",
    title: "Test Password",
    pattern: String.raw`password\s*[:=]\s*['"]?([^'"\s]{8,32})['"]?`,
    keywords: ["password"],
    caseInsensitive: true,
  },
  {
    id: "test-github-pat",
    category: "test",
    title: "Test GitHub PAT",
    pattern: String.raw`(ghp_[0-9a-zA-Z]{36})`,
    keywords: ["ghp_"],
  },
  {
    id: "test-bare-token",
    category: "test",
    title: "Bare token (value-only match)",
    pattern: String.raw`(tok_[a-zA-Z0-9]{12})`,
    keywords: ["tok_"],
  },
];

describe("stripInvisibleUnicode", () => {
  test("removes Unicode tag characters", () => {
    const tag = String.fromCodePoint(0xe0061);
    const input = `hello${tag}world`;
    const result = stripInvisibleUnicode(input);
    expect(result).toBe("helloworld");
  });

  test("passes through clean strings unchanged", () => {
    const input = "clean string";
    expect(stripInvisibleUnicode(input)).toBe(input);
  });
});

describe("redactStringValue", () => {
  test("redacts a known secret pattern", () => {
    const cache = new Map<string, string>();
    const result = redactStringValue(
      "my key is sk-test-abc123def456ghi789jkl012mnopqrxx",
      TEST_PATTERNS,
      cache,
    );
    expect(result).toBe("my key is [REDACTED:test-api-key]");
  });

  test("redacts password-like patterns in config strings", () => {
    const cache = new Map<string, string>();
    const result = redactStringValue(
      'config: password = "supersecret123"',
      TEST_PATTERNS,
      cache,
    );
    expect(result).toContain("[REDACTED:test-password]");
    expect(result).not.toContain("supersecret123");
  });

  test("returns non-string values unchanged", () => {
    const cache = new Map<string, string>();
    expect(redactStringValue(null, TEST_PATTERNS, cache)).toBe(null);
    expect(redactStringValue(undefined, TEST_PATTERNS, cache)).toBe(undefined);
    expect(redactStringValue(42 as unknown as string, TEST_PATTERNS, cache)).toBe(42);
  });

  test("skips patterns when keyword not found", () => {
    const cache = new Map<string, string>();
    const result = redactStringValue("no secrets here", TEST_PATTERNS, cache);
    expect(result).toBe("no secrets here");
  });

  test("caches repeated strings", () => {
    const cache = new Map<string, string>();
    const input = "use key sk-test-abc123def456ghi789jkl012mnopqr here";
    const r1 = redactStringValue(input, TEST_PATTERNS, cache);
    const r2 = redactStringValue(input, TEST_PATTERNS, cache);
    expect(r1).toBe(r2);
    expect(cache.size).toBe(1);
  });
});

describe("redactDeep", () => {
  test("redacts strings in arrays", () => {
    const cache = new Map<string, string>();
    const result = redactDeep(
      ["ghp_abcdefghijklmnopqrstuvwxyz1234567890", "normal"],
      TEST_PATTERNS,
      cache,
    );
    expect(result).toEqual(["[REDACTED:test-github-pat]", "normal"]);
  });

  test("redacts strings in nested objects", () => {
    const cache = new Map<string, string>();
    const result = redactDeep(
      { auth: { token: "ghp_abcdefghijklmnopqrstuvwxyz1234567890" }, name: "test" },
      TEST_PATTERNS,
      cache,
    );
    expect(result).toEqual({
      auth: { token: "[REDACTED:test-github-pat]" },
      name: "test",
    });
  });

  test("preserves base64/image data untouched", () => {
    const cache = new Map<string, string>();
    const image = { type: "base64", data: "ghp_abcdefghijklmnopqrstuvwxyz1234567890" };
    const result = redactDeep(image, TEST_PATTERNS, cache);
    expect(result).toEqual(image);
  });

  test("passes through null, numbers, booleans", () => {
    const cache = new Map<string, string>();
    expect(redactDeep(null, TEST_PATTERNS, cache)).toBe(null);
    expect(redactDeep(42, TEST_PATTERNS, cache)).toBe(42);
    expect(redactDeep(false, TEST_PATTERNS, cache)).toBe(false);
  });
});

describe("redact (top-level)", () => {
  test("redacts complex nested payload", () => {
    const payload = {
      messages: [
        { role: "user", content: "my token: sk-test-AbCdEf1234567890AbCdEf1234567890xx" },
        { role: "assistant", content: "ok, using ghp_abcdefghijklmnopqrstuvwxyz1234567890" },
      ],
      config: { secret: "my tok_12AbCdEfGhIj value" },
    };
    const result = redact(payload, TEST_PATTERNS) as typeof payload;

    expect(result.messages[0].content).toContain("[REDACTED:test-api-key]");
    expect(result.messages[1].content).toContain("[REDACTED:test-github-pat]");
    expect(result.config.secret).toContain("[REDACTED:test-bare-token]");
  });
});

describe("redactByPaths", () => {
  test("redacts fields at specified paths", () => {
    const obj = {
      token: "abc123",
      user: { name: "bob", password: "secret" },
      items: [
        { id: 1, secret: "x" },
        { id: 2, secret: "y" },
      ],
    };
    const result = redactByPaths(obj, ["token", "user.password"]) as Record<string, unknown>;
    expect(result.token).toBe("[REDACTED]");
    expect((result.user as Record<string, unknown>).password).toBe("[REDACTED]");
    expect((result.user as Record<string, unknown>).name).toBe("bob");
  });

  test("handles missing paths gracefully", () => {
    const result = redactByPaths({ a: 1 }, ["b.c.d"]);
    expect(result).toEqual({ a: 1 });
  });
});
