/**
 * The Rust/WASM detection core reports match offsets as UTF-8 byte offsets,
 * while the extension works with JavaScript string indices (UTF-16 code
 * units). Convert a UTF-8 byte offset into a JS string index.
 *
 * Iterating with `for...of` walks whole code points, so surrogate pairs
 * (emoji, CJK extension characters) advance by their full 4-byte UTF-8
 * length and 2-code-unit JS length instead of being counted twice.
 */
export function byteOffsetToJsIndex(text: string, byteOffset: number): number {
  let bytes = 0;
  let jsIndex = 0;

  for (const char of text) {
    if (bytes >= byteOffset) {
      return jsIndex;
    }

    bytes += utf8ByteLength(char);
    jsIndex += char.length;
  }

  return text.length;
}

function utf8ByteLength(char: string): number {
  const codePoint = char.codePointAt(0) ?? 0;
  if (codePoint <= 0x7f) {
    return 1;
  }
  if (codePoint <= 0x7ff) {
    return 2;
  }
  if (codePoint <= 0xffff) {
    return 3;
  }
  return 4;
}
