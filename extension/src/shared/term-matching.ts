import type { DetectedTerm } from "./types";

export function findAllowedOccurrences(text: string, term: string): Array<[number, number]> {
  return findAllowedOccurrencesWithOptions(text, term, false);
}

export function findAllowedOccurrencesIgnoreCase(text: string, term: string): Array<[number, number]> {
  return findAllowedOccurrencesWithOptions(text, term, true);
}

function findAllowedOccurrencesWithOptions(text: string, term: string, ignoreCase: boolean): Array<[number, number]> {
  const matches: Array<[number, number]> = [];
  const haystack = ignoreCase ? text.toLocaleLowerCase() : text;
  const needle = ignoreCase ? term.toLocaleLowerCase() : term;
  let from = 0;
  while (from < text.length) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) {
      break;
    }

    const end = index + needle.length;
    if (isAllowedTermOccurrence(text, index, end, text.slice(index, end))) {
      matches.push([index, end]);
    }
    from = index + Math.max(needle.length, 1);
  }
  return matches;
}

export function filterAllowedDetectedTerms(text: string, terms: DetectedTerm[]): DetectedTerm[] {
  return terms.filter((term) => isAllowedTermOccurrence(text, term.start, term.end, term.term));
}

export function isAllowedTermOccurrence(text: string, start: number, end: number, term: string): boolean {
  if (start < 0 || end > text.length || start >= end) {
    return false;
  }

  if (isInsideUrlEmailOrPathToken(text, start, end)) {
    return false;
  }

  if (!isAsciiWordTerm(term)) {
    return true;
  }

  return !isAsciiWordChar(text[start - 1]) && !isAsciiWordChar(text[end]);
}

function isInsideUrlEmailOrPathToken(text: string, start: number, end: number): boolean {
  const tokenStart = findTokenStart(text, start);
  const tokenEnd = findTokenEnd(text, end);
  const token = text.slice(tokenStart, tokenEnd);
  if (!token || token.length <= end - start) {
    return false;
  }

  return isUrlLikeToken(token) || isEmailLikeToken(token) || isPathLikeToken(token);
}

function findTokenStart(text: string, start: number): number {
  let index = start;
  while (index > 0 && !isTokenBreak(text[index - 1])) {
    index -= 1;
  }
  return index;
}

function findTokenEnd(text: string, end: number): number {
  let index = end;
  while (index < text.length && !isTokenBreak(text[index])) {
    index += 1;
  }
  return index;
}

function isTokenBreak(char: string): boolean {
  return /\s/.test(char) || /[<>"'“”‘’()（）\[\]{}，。！？；、]/.test(char);
}

function isUrlLikeToken(token: string): boolean {
  const trimmed = trimTokenPunctuation(token);
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    || /^www\./i.test(trimmed)
    || /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/:?#][^\s]*)?$/i.test(trimmed)
    || /[/?#=&]/.test(trimmed) && /\.[a-z]{2,}/i.test(trimmed);
}

function isEmailLikeToken(token: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimTokenPunctuation(token));
}

function isPathLikeToken(token: string): boolean {
  const trimmed = trimTokenPunctuation(token);
  return /^[A-Za-z]:[\\/]/.test(trimmed)
    || /^~?[\\/]/.test(trimmed)
    || /[\\/]/.test(trimmed) && /\.[A-Za-z0-9]{1,8}(?:$|[?#])/.test(trimmed)
    || /^[\w.-]+(?:[\\/][\w.-]+)+$/.test(trimmed);
}

function trimTokenPunctuation(token: string): string {
  return token.replace(/^[,.;:!?]+|[,.;:!?]+$/g, "");
}

function isAsciiWordTerm(term: string): boolean {
  return /^[A-Za-z0-9_]+$/.test(term);
}

function isAsciiWordChar(char: string | undefined): boolean {
  return char !== undefined && /^[A-Za-z0-9_]$/.test(char);
}
