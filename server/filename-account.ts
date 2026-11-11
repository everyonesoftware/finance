// Extract only account-number suffixes; never treat arbitrary digit substrings
// or dates in an export name as account evidence.
export function filenameAccountMasks(fileName: string): string[] {
  const name = fileName.split(/[\\/]/).at(-1)!.replace(/\.(csv|ofx|qfx)$/i, "");
  const labeled = new Set([...name.matchAll(/(?:^|[^a-z0-9])(?:account|acct)[ _-]*([a-z]*\d{4,})(?=$|[^a-z0-9])/gi)].map(match => match[1].toLowerCase()));
  const withoutDates = name.replace(/\b\d{4}[-.]\d{2}[-.]\d{2}\b|\b\d{2}[-.]\d{2}[-.]\d{4}\b/g, " ");
  const tokens = withoutDates.match(/[a-z0-9]+/gi) ?? [];
  return [...new Set(tokens.filter(token => {
    if (!/^[a-z]*\d{4,}$/i.test(token)) return false;
    if (labeled.has(token.toLowerCase())) return true;
    const digits = token.replace(/^[a-z]+/i, "");
    return !/^(?:(?:19|20)\d{2}|(?:19|20)\d{6}|\d{4}(?:19|20)\d{2})$/.test(digits);
  }).map(token => token.slice(-4)))];
}
