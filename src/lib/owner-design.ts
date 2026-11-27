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
