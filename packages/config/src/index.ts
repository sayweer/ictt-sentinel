// @ictt-sentinel/config
// Manifest and policy schema plus validation. Parses injected input; never reads process.env itself.
//
// Scaffold only: no product behaviour yet. The package name is exported so the
// module has a checkable public surface and the build graph is exercised.
export const PACKAGE_NAME = '@ictt-sentinel/config' as const;
