export function utf8ByteOffsetToUtf16Index(text: string, byteOffset: number): number {
  if (!Number.isFinite(byteOffset) || byteOffset <= 0) {
    return 0;
  }

  let bytes = 0;
  let utf16Index = 0;
  for (const codePoint of text) {
    if (bytes >= byteOffset) {
      return utf16Index;
    }
    bytes += utf8ByteLength(codePoint);
    utf16Index += codePoint.length;
  }

  return text.length;
}

function utf8ByteLength(codePoint: string): number {
  const value = codePoint.codePointAt(0) ?? 0;
  if (value <= 0x7f) return 1;
  if (value <= 0x7ff) return 2;
  if (value <= 0xffff) return 3;
  return 4;
}
