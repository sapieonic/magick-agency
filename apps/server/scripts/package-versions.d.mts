export const WORKSPACE: RegExp;
export function readWorkspaceManifest(name: string): { version: string };
export function bundledPackageVersions(
  pkg: { dependencies?: Record<string, string> },
  readManifest?: (name: string) => { version: unknown },
): Record<string, string>;
export function assertBundled(metafile: { inputs: Record<string, unknown> }, versions: Record<string, string>): void;
