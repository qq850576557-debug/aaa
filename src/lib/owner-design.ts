/** Only approved HTTPS origins may be opened. Do not turn this into an outbound fetch. */
export function designUrl(input: string, origins: readonly string[]) {
  if (
    input.length > 1500 ||
    /[\s\\\u0000-\u001f\u007f]/u.test(input) ||
    !/^https:\/\//i.test(input)
  )
    return '';
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.username || url.password || !origins.includes(url.origin))
      return '';
    return url.href.length <= 1500 ? url.href : '';
  } catch {
    return '';
  }
}
