import JSON5 from "json5";

/**
 * Sanitize literal newlines, carriage returns, and tabs that appear
 * INSIDE JSON string values.  Uses a simple state-machine so it only
 * escapes characters that are truly inside quoted strings.
 */
function sanitizeJsonStrings(raw) {
  let result = "";
  let inString = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];

    if (inString) {
      // Escaped character – copy both and move on
      if (ch === "\\") {
        result += ch + (raw[i + 1] || "");
        i++;
        continue;
      }
      // End of string
      if (ch === '"') {
        inString = false;
        result += ch;
        continue;
      }
      // --- The problem characters ---
      if (ch === "\n") { result += "\\n"; continue; }
      if (ch === "\r") { result += "\\r"; continue; }
      if (ch === "\t") { result += "\\t"; continue; }

      result += ch;
    } else {
      if (ch === '"') inString = true;
      result += ch;
    }
  }

  return result;
}

/**
 * Extract the raw JSON portion from an LLM response that may contain
 * markdown fences, prose, or trailing commas.
 */
function extractRawJson(text) {
  // Try to get JSON from markdown code block first
  const jsonMatch =
    text.match(/```json\s*([\s\S]*?)```/i) ||
    text.match(/```([\s\S]*?)```/i);
  let raw = jsonMatch ? jsonMatch[1] : text;
  raw = raw.trim();
  if (raw.endsWith(",")) raw = raw.slice(0, -1);
  return raw;
}

/**
 * Robustly parse a JSON (or JSON-ish) string from an LLM response.
 *
 * Parsing chain (tries each in order, returns first success):
 *  1. JSON.parse(raw)                   — fast, strict
 *  2. JSON5.parse(raw)                  — lenient (trailing commas, single quotes…)
 *  3. sanitize + JSON.parse             — fixes literal newlines in strings
 *  4. sanitize + JSON5.parse            — both fixes combined
 *  5. Extract outermost { … } + repeat  — strip leading/trailing prose
 */
export function parseJsonResponse(text) {
  const raw = extractRawJson(text);

  // 1. Strict JSON
  try { return JSON.parse(raw); } catch (_) { /* continue */ }

  // 2. JSON5 (handles trailing commas, unquoted keys, etc.)
  try { return JSON5.parse(raw); } catch (_) { /* continue */ }

  // 3. Sanitize literal newlines inside strings, then strict JSON
  const sanitized = sanitizeJsonStrings(raw);
  try { return JSON.parse(sanitized); } catch (_) { /* continue */ }

  // 4. Sanitized + JSON5
  try { return JSON5.parse(sanitized); } catch (_) { /* continue */ }

  // 5. Extract the outermost { … } or [ … ] and retry
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    const sliced = raw.slice(start, end + 1);
    try { return JSON.parse(sliced); } catch (_) { /* continue */ }
    try { return JSON5.parse(sliced); } catch (_) { /* continue */ }

    const slicedSanitized = sanitizeJsonStrings(sliced);
    try { return JSON.parse(slicedSanitized); } catch (_) { /* continue */ }
    try { return JSON5.parse(slicedSanitized); } catch (_) { /* continue */ }
  }

  // 6. Last resort – try extracting array
  const arrStart = raw.indexOf("[");
  const arrEnd = raw.lastIndexOf("]");
  if (arrStart !== -1 && arrEnd !== -1 && arrEnd > arrStart) {
    const sliced = raw.slice(arrStart, arrEnd + 1);
    const slicedSanitized = sanitizeJsonStrings(sliced);
    try { return JSON.parse(slicedSanitized); } catch (_) { /* continue */ }
    try { return JSON5.parse(slicedSanitized); } catch (_) { /* continue */ }
  }

  throw new Error("Failed to parse JSON from LLM response");
}
