/**
 * Lowercase only ASCII A-Z. In particular, this deliberately does not trim,
 * perform Unicode normalization, or apply JavaScript's locale/Unicode case
 * mappings.
 */
export function canonicalizeAsciiUppercase(value: string): string {
  let canonical = "";

  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    canonical +=
      codePoint >= 0x41 && codePoint <= 0x5a ? String.fromCharCode(codePoint + 0x20) : value[index];
  }

  return canonical;
}

/** Return whether every code unit in a value is an ASCII octet. */
export function isAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) {
      return false;
    }
  }

  return true;
}

/** Count UTF-8 octets without relying on a runtime-specific encoder. */
export function utf8ByteLength(value: string): number {
  let length = 0;

  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) {
      length += 1;
    } else if (codePoint <= 0x7ff) {
      length += 2;
    } else if (codePoint <= 0xffff) {
      length += 3;
    } else {
      length += 4;
    }
  }

  return length;
}
