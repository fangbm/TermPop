export const SITE_ACCESS_STORAGE_KEY = "termpop.enabledOrigins";

export function originPatternFromUrl(value: string | undefined): string | undefined {
  if (!value || /^chrome(?:-extension)?:/i.test(value) || /^edge:/i.test(value) || /^about:/i.test(value)) {
    return undefined;
  }
  if (/^file:/i.test(value)) {
    return "file:///*";
  }

  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    return `${url.origin}/*`;
  } catch {
    return undefined;
  }
}

export function domainFromUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (/^file:/i.test(value)) {
    return "file://";
  }

  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.hostname.toLocaleLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

export function pageFingerprintFromUrlAndText(url: string | undefined, text: string | undefined): string {
  const normalizedUrl = normalizeUrlForFingerprint(url);
  const normalizedText = (text ?? "").replace(/\s+/g, " ").trim().slice(0, 2400);
  return hashString(`${normalizedUrl}\n${normalizedText}`);
}

export function sanitizeForLog(value: unknown, maxLength = 500): string {
  return truncate(redactSecrets(stringifyForLog(value)).replace(/\s+/g, " ").trim(), maxLength);
}

export function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function normalizeUrlForFingerprint(value: string | undefined): string {
  if (!value) {
    return "";
  }
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

function stringifyForLog(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function redactSecrets(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer ***")
    .replace(/\b(sk|ak|pk|rk)-[A-Za-z0-9_\-]{8,}\b/g, "$1-***")
    .replace(/("(?:authorization|apiKey|x-api-key)"\s*:\s*")[^"]+(")/gi, "$1***$2")
    .replace(/((?:authorization|apiKey|x-api-key)\s*[:=]\s*)[^\s,;}"']+/gi, "$1***");
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}
