/**
 * Compatibility entry point for control-plane callers. The structural facade
 * is defined in core to keep the shared package free of Cloudflare imports.
 */
export { createReadOnlyR2Bucket, createReadOnlyR2Facade } from "@zudo-ez-host/core";
export type {
  ReadOnlyR2Bucket,
  ReadOnlyR2Checksums,
  ReadOnlyR2Object,
  ReadOnlyR2ObjectBody,
  R2Reader,
} from "@zudo-ez-host/core";
