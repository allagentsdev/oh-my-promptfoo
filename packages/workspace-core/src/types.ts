export type RuntimeChannels = Record<string, string | undefined>;
export interface SourceLimits {
  maxSources: number;
  maxDownloadBytes: number;
  maxExtractedBytes: number;
  timeoutMs: number;
}
export interface GitSource {
  type: "git";
  repository: string;
  ref: string;
  destination: string;
  permissions?: "all" | "read-only";
}
export type OciSource = {
  type: "oci";
  repository: string;
  destination: string;
  permissions?: "all" | "read-only";
} & ({ digest: `sha256:${string}`; tag?: never } | { tag: string; digest?: never });
export type WorkspaceSource = GitSource | OciSource;
export interface WorkspaceSpec {
  sources: WorkspaceSource[];
  limits?: Partial<SourceLimits>;
}
export type ResolvedSource =
  | (GitSource & { commit: string; materializerVersion?: number })
  | {
      type: "oci";
      repository: string;
      destination: string;
      permissions?: "all" | "read-only";
      digest: `sha256:${string}`;
      tag?: string;
      materializerVersion?: number;
    };
export type Digest = `sha256:${string}`;
export interface ProcessIdentity {
  pid: number;
  start: string;
  hostname: string;
  boot: string;
}
export interface Ownership {
  schemaVersion: 1;
  package: "@allagents/promptfoo-integration";
  kind: string;
  identity?: ProcessIdentity;
}
export type AdapterKind = "reflink" | "overlay" | "copy";
export interface SourceView {
  probe?: boolean;
  destination: string;
  adapter: AdapterKind | "read-only";
  seedSource: string;
  path: string;
  statePath?: string;
  checkoutKey?: string;
}
export interface RecoveryRecord {
  schemaVersion: 1;
  id: string;
  root: string;
  path: string;
  digest: Digest;
  identity: ProcessIdentity;
  status: "pending" | "active" | "released";
  seedLease: boolean;
  views: SourceView[];
}
export interface WorkspaceHandle {
  path: string;
  manifestDigest: Digest;
  sources: ResolvedSource[];
  seedPath: string;
  adapters: SourceView[];
}
export interface TreeEntry {
  path: string;
  kind: "file" | "symlink" | "directory";
  mode: number;
  size: number;
  digest?: string;
  target?: string;
}
export interface SeedMetadata {
  schemaVersion: 1;
  package: "@allagents/promptfoo-integration";
  digest: Digest;
  sources: ResolvedSource[];
  inventory: TreeEntry[];
  allocatedBytes: number;
  createdAt: number;
  lastUsed: number;
}
export interface PruneReport {
  removedBytes?: number;
  retainedBytes?: number;
  removedCount?: number;
  retainedCount?: number;
  removed: string[];
  retained: string[];
  allocatedBytes: number;
  errors: string[];
}
