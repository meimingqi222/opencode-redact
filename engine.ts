/**
 * Self-contained secret redaction engine.
 * Strips invisible Unicode, detects secrets via keyword+regex, and
 * recursively redacts objects/arrays — no external dependencies.
 */

const UNICODE_TAGS_RE = /[\uDB40][\uDC00-\uDC7F]/g;
const MAX_CACHE_SIZE = 2000;
const MAX_CACHE_ENTRY_LENGTH = 512_000;

let _logger: Pick<typeof console, "warn" | "info"> = console;

export function setLogger(log: Pick<typeof console, "warn" | "info">) {
  _logger = log;
}

// ---- Patterns ----------------------------------------------------------------

export interface SecretPattern {
  id: string;
  category: string;
  title: string;
  pattern: string; // String.raw regex
  keywords: string[];
  caseInsensitive?: boolean;
  _regex?: RegExp;
}

// ---- Regex Compilation -------------------------------------------------------

function compileRegex(entry: SecretPattern): RegExp {
  if (!entry._regex) {
    try {
      entry._regex = new RegExp(entry.pattern, entry.caseInsensitive ? "gi" : "g");
    } catch (err) {
      _logger.warn("Error compiling regex", { pattern: entry.id, error: err });
      entry._regex = /^$/;
    }
  }
  return entry._regex;
}

// ---- Unicode Stripping -------------------------------------------------------

export function stripInvisibleUnicode(input: string): string {
  const stripped = input.replace(UNICODE_TAGS_RE, "");
  if (stripped.length !== input.length) {
    _logger.info("Invisible Unicode tag characters removed during sanitization", {
      removedCount: input.length - stripped.length,
    });
  }
  return stripped;
}

// ---- String-Level Redaction --------------------------------------------------

/**
 * Redact secrets from a single string value.
 * Uses keyword pre-filtering → regex replacement → Map caching.
 */
export function redactStringValue(
  input: string | null | undefined,
  patterns: SecretPattern[],
  cache: Map<string, string>,
): string | null | undefined {
  if (!input || typeof input !== "string") return input;

  let existing = cache.get(input);
  if (existing !== undefined) return existing;

  let result = stripInvisibleUnicode(input);

  for (const entry of patterns) {
    const hasKeyword = entry.keywords.some((kw) =>
      entry.caseInsensitive
        ? result.toLowerCase().includes(kw.toLowerCase())
        : result.includes(kw),
    );
    if (!hasKeyword) continue;

    const regex = compileRegex(entry);
    result = result.replace(regex, (full, captured) =>
      full.replace(captured, `[REDACTED:${entry.id}]`),
    );
  }

  if (input.length <= MAX_CACHE_ENTRY_LENGTH) {
    if (cache.size >= MAX_CACHE_SIZE) cache.clear();
    cache.set(input, result);
  }

  return result;
}

// ---- Deep / Recursive Redaction ----------------------------------------------

/**
 * Recursively redact secrets from any value.
 * Preserves image/base64 data untouched.
 */
export function redactDeep(
  value: unknown,
  patterns: SecretPattern[],
  cache: Map<string, string>,
): unknown {
  if (!value || typeof value === "number" || typeof value === "boolean") return value;

  if (typeof value === "string") {
    return redactStringValue(value, patterns, cache) ?? value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "string") return redactStringValue(item, patterns, cache) ?? item;
      if (item && typeof item === "object") return redactDeep(item, patterns, cache);
      return item;
    });
  }

  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;

    if ("type" in obj && (obj.type === "base64" || obj.type === "image") && "data" in obj) {
      return { ...obj };
    }

    if ("isImage" in obj && obj.isImage === true && "content" in obj && typeof obj.content === "string") {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        result[k] = k === "content" ? v : redactDeep(v, patterns, cache);
      }
      return result;
    }

    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, redactDeep(v, patterns, cache)]),
    );
  }

  return value;
}

export function redact(value: unknown, patterns: SecretPattern[]): unknown {
  return redactDeep(value, patterns, new Map());
}

// ---- Path-Based Redaction (simplified, no wildcard support) -------------------

const PATH_NOT_FOUND = Symbol("path_not_found");

function parsePath(path: string): string[] {
  const segs: string[] = [];
  let cur = "", inBr = false, inQ = false, qCh = "";
  for (const ch of path) {
    if (!inBr && ch === ".") {
      if (cur) { segs.push(cur); cur = ""; }
    } else if (ch === "[") {
      if (cur) { segs.push(cur); cur = ""; }
      inBr = true;
    } else if (ch === "]" && inBr) {
      segs.push(cur); cur = ""; inBr = false; inQ = false;
    } else if ((ch === '"' || ch === "'") && inBr) {
      if (!inQ) { inQ = true; qCh = ch; } else if (ch === qCh) { inQ = false; qCh = ""; } else { cur += ch; }
    } else {
      cur += ch;
    }
  }
  if (cur) segs.push(cur);
  return segs;
}

function getAtPath(obj: Record<string, unknown>, segs: string[]): unknown | symbol {
  let cur: unknown = obj;
  for (const s of segs) {
    if (cur === null || cur === undefined) return PATH_NOT_FOUND;
    if (typeof cur !== "object" || cur === null) return PATH_NOT_FOUND;
    if (!(s in (cur as Record<string, unknown>))) return PATH_NOT_FOUND;
    cur = (cur as Record<string, unknown>)[s];
  }
  return cur;
}

function setAtPath(obj: Record<string, unknown>, segs: string[], val: unknown): void {
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i];
    if (typeof cur[s] !== "object" || cur[s] === null) cur[s] = {};
    cur = cur[s] as Record<string, unknown>;
  }
  cur[segs[segs.length - 1]] = val;
}

export function redactByPaths(
  value: unknown,
  paths: string[],
  censor: string = "[REDACTED]",
): unknown {
  if (value === null || typeof value !== "object") return value;
  const clone = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

  for (const p of paths) {
    const segs = parsePath(p);
    const found = getAtPath(clone, segs);
    if (found !== PATH_NOT_FOUND) {
      setAtPath(clone, segs, censor);
    }
  }

  return clone;
}
