import type { Readable } from "node:stream";

export interface ObjectFileMetadata {
  contentType?: string;
  size?: string | number;
  metadata?: Record<string, unknown>;
  timeCreated?: string;
}

/** The subset of the GCS File API used by MogulForge. */
export interface ObjectFile {
  name: string;
  metadata?: ObjectFileMetadata;
  exists(): Promise<[boolean]>;
  getMetadata(): Promise<[ObjectFileMetadata]>;
  setMetadata(input: { metadata?: Record<string, unknown> }): Promise<unknown>;
  createReadStream(): Readable;
  delete(options?: { ignoreNotFound?: boolean }): Promise<unknown>;
}
