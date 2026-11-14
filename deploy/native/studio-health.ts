/** A successful SELECT 1 health response alone is insufficient for this release. */
export function requireStudioHealth(response: { status: number; value: any }) {
  if (
    response.status !== 200 ||
    response.value?.ok !== true ||
    response.value?.capabilities?.studioDaily !== true
  )
    throw Error('Deployment check failed: studio daily schema/grants/API capability not ready');
}
