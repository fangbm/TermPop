export function extractJsonObject(content: string): string {
  const direct = content.trim();
  if (direct.startsWith("{") && direct.endsWith("}") && isParseableJson(direct)) {
    return direct;
  }

  const fenced = direct.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced && fenced.startsWith("{") && fenced.endsWith("}") && isParseableJson(fenced)) {
    return fenced;
  }

  const object = findParseableJsonCandidate(content, "{", "}");
  if (object) {
    return object;
  }

  throw new Error("LLM response was not valid JSON.");
}

export function extractJsonPayload(content: string): string {
  const direct = content.trim();
  if ((direct.startsWith("{") && direct.endsWith("}")) || (direct.startsWith("[") && direct.endsWith("]"))) {
    if (isParseableJson(direct)) {
      return direct;
    }
  }

  const fenced = direct.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced && ((fenced.startsWith("{") && fenced.endsWith("}")) || (fenced.startsWith("[") && fenced.endsWith("]"))) && isParseableJson(fenced)) {
    return fenced;
  }

  return findParseableJsonCandidate(content, "{", "}")
    ?? findParseableJsonCandidate(content, "[", "]")
    ?? (() => {
      throw new Error("LLM response was not valid JSON.");
    })();
}

function findParseableJsonCandidate(text: string, open: "{" | "[", close: "}" | "]"): string | undefined {
  let index = text.indexOf(open);
  while (index >= 0) {
    const end = findMatchingJsonEnd(text, index, open, close);
    if (end > index) {
      const candidate = text.slice(index, end + 1);
      if (isParseableJson(candidate)) {
        return candidate;
      }
    }
    index = text.indexOf(open, index + 1);
  }
  return undefined;
}

function findMatchingJsonEnd(text: string, start: number, open: "{" | "[", close: "}" | "]"): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function isParseableJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}
