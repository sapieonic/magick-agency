export function bundledPackageVersions(
  pkg: { dependencies?: Record<string, string> },
  readManifest: (name: string) => { version: string },
): Record<string, string>;
