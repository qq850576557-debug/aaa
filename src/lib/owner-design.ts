/** Validate a stored HTTPS link. Supply allowed origins when returning it for WeChat web-view. */
export function designUrl(input: string, origins?: readonly string[]) {
  if (
    input.length > 1500 ||
    /[\s\\\u0000-\u001f\u007f]/u.test(input) ||
    !/^https:\/\/[a-z0-9.-]+(?::[0-9]+)?(?=[/?#]|$)/i.test(input)
  )
    return '';
  try {
    const url = new URL(input);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      (origins && !origins.includes(url.origin))
    )
      return '';
    // Keep the provider's path, query and fragment intact, including share signatures.
    return input.replace(/^https:/i, 'https:');
  } catch {
    return '';
  }
}

export function configuredDesignOrigins(config: string) {
  return [
    ...new Set(
      config.split(/[,，\n]/).flatMap((entry) => {
        const value = entry.trim();
        if (
          !/^(?:https:\/\/)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::443)?\/?$/i.test(
            value,
          )
        )
          return [];
        const origin = /^https:/i.test(value) ? value : 'https://' + value;
        return [new URL(origin).origin];
      }),
    ),
  ];
}

export const shinewonderOrigin = 'https://8ec387dc.shinewonder.com';

export function resolveDesignLink(input: string, origins?: readonly string[]) {
  const raw = input.trim();
  if (!raw) return { url: '' };
  const valid = designUrl(raw);
  if (!valid) return { url: '', issue: 'invalid_link' } as const;
  const parsed = new URL(valid);
  const shinewonder =
    parsed.hostname.endsWith('.shinewonder.com') || parsed.hostname === 'shinewonder.com';
  if (shinewonder) {
    if (!['https://vr.shinewonder.com', shinewonderOrigin].includes(parsed.origin))
      return { url: '', issue: 'domain_unconfigured' } as const;
    const rawPath = valid.replace(/^https:\/\/[^/?#]+/i, '').split(/[?#]/, 1)[0];
    if (!/^\/pano\/page\/publik\/pklimit\/?$/i.test(rawPath))
      return { url: '', issue: 'preview_link' } as const;
    const codes = parsed.searchParams.getAll('inf');
    if (codes.length !== 1 || !codes[0].trim()) return { url: '', issue: 'invalid_link' } as const;
  }
  const url =
    parsed.origin === 'https://vr.shinewonder.com'
      ? valid.replace(/^https:\/\/[^/?#]+/i, shinewonderOrigin)
      : valid;
  if (url.length > 1500) return { url: '', issue: 'invalid_link' } as const;
  return designUrl(url, origins) ? { url } : ({ url: '', issue: 'domain_unconfigured' } as const);
}
