// Keep a touch phone in the assistant when rotated; desktop layouts remain unchanged.
export const MOBILE_QUERY = '(max-width:700px), (pointer:coarse) and (max-width:1024px)';
export function mobileRequested() {
  return (
    matchMedia(MOBILE_QUERY).matches || new URLSearchParams(location.search).get('mobile') === '1'
  );
}
