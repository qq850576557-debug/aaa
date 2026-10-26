// Explicit module grants. Backend always derives owner from the authenticated
// workspace owner ID; a client-supplied role/permission never grants access.
export function accountPermissions(owner: boolean) {
  return {
    directory: true,
    audit: true, // Both roles may read their own studio's audit, per product policy.
    backupImport: owner,
    manageAccounts: owner,
    changeLogin: owner,
    privatePersonnel: owner,
  };
}
export type AccountPermission = keyof ReturnType<typeof accountPermissions>;
