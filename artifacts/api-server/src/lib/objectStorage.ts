import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";

import { Storage } from "@google-cloud/storage";
import { db, storedObjectsTable, type StoredObject } from "@workspace/db";
import { and, eq } from "drizzle-orm";

import {
  canAccessObject,
  getObjectAclPolicy,
  type ObjectAclPolicy,
  ObjectPermission,
  setObjectAclPolicy,
} from "./objectAcl";
import type { ObjectFile, ObjectFileMetadata } from "./objectFile";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";
const LOCAL_UPLOAD_PATH = "/api/v1/public/uploads/local";
const UPLOAD_TTL_SECONDS = 15 * 60;
const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const objectStorageClient = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: { type: "json", subject_token_field_name: "access_token" },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

interface UploadTokenPayload {
  id: string;
  exp: number;
  organizationId?: string;
  contentType?: string;
  expectedBytes?: number;
}

export interface UploadUrlOptions {
  organizationId?: string;
  contentType?: string;
  size?: number;
}

export interface StoredUpload {
  objectPath: string;
  createdAt: Date;
  remove: () => Promise<void>;
}

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

export class InvalidUploadTokenError extends Error {
  constructor(message = "Invalid or expired upload token") {
    super(message);
    this.name = "InvalidUploadTokenError";
  }
}

function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET is required to sign private upload URLs");
  }
  return secret;
}

function useGoogleProvider(): boolean {
  const configured = process.env.OBJECT_STORAGE_PROVIDER?.trim().toLowerCase();
  if (configured === "replit" || configured === "gcs") return true;
  if (configured === "postgres" || configured === "database") return false;
  return Boolean(process.env.PRIVATE_OBJECT_DIR);
}

function encodeUploadToken(payload: UploadTokenPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", sessionSecret())
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${signature}`;
}

function decodeUploadToken(
  token: string,
  objectId: string,
): UploadTokenPayload {
  const [encoded, suppliedSignature, ...extra] = token.split(".");
  if (!encoded || !suppliedSignature || extra.length > 0) {
    throw new InvalidUploadTokenError();
  }
  const expectedSignature = createHmac("sha256", sessionSecret())
    .update(encoded)
    .digest("base64url");
  const supplied = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    throw new InvalidUploadTokenError();
  }
  let payload: UploadTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new InvalidUploadTokenError();
  }
  if (
    payload.id !== objectId ||
    !Number.isFinite(payload.exp) ||
    payload.exp < Date.now()
  ) {
    throw new InvalidUploadTokenError();
  }
  return payload;
}

class PostgresObjectFile implements ObjectFile {
  readonly name: string;
  readonly metadata: ObjectFileMetadata;

  constructor(private row: StoredObject) {
    this.name = `uploads/${row.id}`;
    this.metadata = this.toMetadata();
  }

  private toMetadata(): ObjectFileMetadata {
    return {
      contentType: this.row.contentType,
      size: String(this.row.sizeBytes),
      metadata: this.row.metadata,
      timeCreated: this.row.createdAt.toISOString(),
    };
  }

  async exists(): Promise<[boolean]> {
    const [row] = await db
      .select({ id: storedObjectsTable.id })
      .from(storedObjectsTable)
      .where(eq(storedObjectsTable.id, this.row.id));
    return [Boolean(row)];
  }

  async getMetadata(): Promise<[ObjectFileMetadata]> {
    return [this.toMetadata()];
  }

  async setMetadata(input: {
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const metadata = input.metadata ?? {};
    await db
      .update(storedObjectsTable)
      .set({ metadata })
      .where(eq(storedObjectsTable.id, this.row.id));
    this.row = { ...this.row, metadata };
  }

  createReadStream(): Readable {
    return Readable.from(this.row.data);
  }

  async delete(): Promise<void> {
    await db
      .delete(storedObjectsTable)
      .where(eq(storedObjectsTable.id, this.row.id));
  }
}

export class ObjectStorageService {
  isDatabaseProvider(): boolean {
    return !useGoogleProvider();
  }

  getPublicObjectSearchPaths(): string[] {
    const pathsStr = process.env.PUBLIC_OBJECT_SEARCH_PATHS || "";
    return Array.from(
      new Set(
        pathsStr
          .split(",")
          .map((path) => path.trim())
          .filter(Boolean),
      ),
    );
  }

  getPrivateObjectDir(): string {
    const dir = process.env.PRIVATE_OBJECT_DIR || "";
    if (!dir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR is required when OBJECT_STORAGE_PROVIDER is replit or gcs",
      );
    }
    return dir;
  }

  async searchPublicObject(filePath: string): Promise<ObjectFile | null> {
    if (this.isDatabaseProvider()) return null;
    for (const searchPath of this.getPublicObjectSearchPaths()) {
      const { bucketName, objectName } = parseObjectPath(
        `${searchPath}/${filePath}`,
      );
      const file = objectStorageClient.bucket(bucketName).file(objectName);
      const [exists] = await file.exists();
      if (exists) return file as unknown as ObjectFile;
    }
    return null;
  }

  async downloadObject(
    file: ObjectFile,
    cacheTtlSec = 3600,
  ): Promise<Response> {
    const [metadata] = await file.getMetadata();
    const aclPolicy = await getObjectAclPolicy(file);
    const isPublic = aclPolicy?.visibility === "public";
    const webStream = Readable.toWeb(file.createReadStream()) as ReadableStream;
    const headers: Record<string, string> = {
      "Content-Type": metadata.contentType || "application/octet-stream",
      "Cache-Control": `${isPublic ? "public" : "private"}, max-age=${cacheTtlSec}`,
    };
    if (metadata.size) headers["Content-Length"] = String(metadata.size);
    return new Response(webStream, { headers });
  }

  async getObjectEntityUploadURL(
    options: UploadUrlOptions = {},
  ): Promise<string> {
    const objectId = randomUUID();
    if (this.isDatabaseProvider()) {
      const token = encodeUploadToken({
        id: objectId,
        exp: Date.now() + UPLOAD_TTL_SECONDS * 1000,
        organizationId: options.organizationId,
        contentType: options.contentType,
        expectedBytes: options.size,
      });
      return `${LOCAL_UPLOAD_PATH}/${objectId}?token=${encodeURIComponent(token)}`;
    }
    const fullPath = `${this.getPrivateObjectDir()}/uploads/${objectId}`;
    const { bucketName, objectName } = parseObjectPath(fullPath);
    return signObjectURL({
      bucketName,
      objectName,
      method: "PUT",
      ttlSec: UPLOAD_TTL_SECONDS,
    });
  }

  async storeDatabaseUpload(params: {
    objectId: string;
    token: string;
    data: Buffer;
    contentType: string;
  }): Promise<void> {
    if (!this.isDatabaseProvider()) {
      throw new InvalidUploadTokenError("Local uploads are not enabled");
    }
    const payload = decodeUploadToken(params.token, params.objectId);
    const maxBytes = payload.expectedBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
    if (
      params.data.length <= 0 ||
      params.data.length > DEFAULT_MAX_UPLOAD_BYTES ||
      params.data.length > maxBytes
    ) {
      throw new InvalidUploadTokenError(
        "Upload size does not match the signed request",
      );
    }
    const normalizedContentType = params.contentType
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (
      payload.contentType &&
      normalizedContentType !== payload.contentType.toLowerCase()
    ) {
      throw new InvalidUploadTokenError(
        "Upload content type does not match the signed request",
      );
    }
    await db.insert(storedObjectsTable).values({
      id: params.objectId,
      organizationId: payload.organizationId,
      data: params.data,
      contentType: normalizedContentType || "application/octet-stream",
      sizeBytes: params.data.length,
    });
  }

  async getObjectEntityFile(
    objectPath: string,
    organizationId?: string,
  ): Promise<ObjectFile> {
    if (!objectPath.startsWith("/objects/")) throw new ObjectNotFoundError();
    const parts = objectPath.slice(1).split("/");
    if (parts.length < 2) throw new ObjectNotFoundError();
    const entityId = parts.slice(1).join("/");
    if (this.isDatabaseProvider()) {
      const match = /^uploads\/([0-9a-f-]{36})$/i.exec(entityId);
      if (!match) throw new ObjectNotFoundError();
      const [row] = await db
        .select()
        .from(storedObjectsTable)
        .where(
          organizationId
            ? and(
                eq(storedObjectsTable.id, match[1]),
                eq(storedObjectsTable.organizationId, organizationId),
              )
            : eq(storedObjectsTable.id, match[1]),
        );
      if (!row) throw new ObjectNotFoundError();
      return new PostgresObjectFile(row);
    }
    // Legacy GCS/Replit uploads have no authoritative, server-owned tenant
    // association. Caller-supplied activity links or arbitrary object metadata
    // cannot establish ownership. Keep scoped reads/attachment checks closed
    // until that provider has a reviewed ownership registry and migration.
    if (organizationId) throw new ObjectNotFoundError();
    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith("/")) entityDir += "/";
    const { bucketName, objectName } = parseObjectPath(
      `${entityDir}${entityId}`,
    );
    const file = objectStorageClient.bucket(bucketName).file(objectName);
    const [exists] = await file.exists();
    if (!exists) throw new ObjectNotFoundError();
    return file as unknown as ObjectFile;
  }

  normalizeObjectEntityPath(rawPath: string): string {
    let pathname = rawPath;
    try {
      pathname = new URL(rawPath, "http://mogulforge.local").pathname;
    } catch {
      return rawPath;
    }
    const localMatch = new RegExp(
      `^${LOCAL_UPLOAD_PATH}/([0-9a-f-]{36})$`,
      "i",
    ).exec(pathname);
    if (localMatch) return `/objects/uploads/${localMatch[1]}`;
    if (!rawPath.startsWith("https://storage.googleapis.com/")) return rawPath;
    let objectEntityDir = this.getPrivateObjectDir();
    if (!objectEntityDir.endsWith("/")) objectEntityDir += "/";
    if (!pathname.startsWith(objectEntityDir)) return pathname;
    return `/objects/${pathname.slice(objectEntityDir.length)}`;
  }

  async trySetObjectEntityAclPolicy(
    rawPath: string,
    aclPolicy: ObjectAclPolicy,
  ): Promise<string> {
    const normalizedPath = this.normalizeObjectEntityPath(rawPath);
    if (!normalizedPath.startsWith("/")) return normalizedPath;
    const objectFile = await this.getObjectEntityFile(normalizedPath);
    await setObjectAclPolicy(objectFile, aclPolicy);
    return normalizedPath;
  }

  async canAccessObjectEntity({
    userId,
    objectFile,
    requestedPermission,
  }: {
    userId?: string;
    objectFile: ObjectFile;
    requestedPermission?: ObjectPermission;
  }): Promise<boolean> {
    return canAccessObject({
      userId,
      objectFile,
      requestedPermission: requestedPermission ?? ObjectPermission.READ,
    });
  }

  async listObjectEntityUploads(): Promise<StoredUpload[]> {
    if (this.isDatabaseProvider()) {
      const rows = await db.select().from(storedObjectsTable);
      return rows.map((row) => ({
        objectPath: `/objects/uploads/${row.id}`,
        createdAt: row.createdAt,
        remove: async () => {
          await db
            .delete(storedObjectsTable)
            .where(eq(storedObjectsTable.id, row.id));
        },
      }));
    }
    let privateDir = this.getPrivateObjectDir();
    if (privateDir.endsWith("/")) privateDir = privateDir.slice(0, -1);
    const parts = privateDir.replace(/^\//, "").split("/");
    const bucketName = parts[0];
    const basePrefix = parts.slice(1).join("/");
    const uploadsPrefix = basePrefix ? `${basePrefix}/uploads/` : "uploads/";
    const [files] = await objectStorageClient
      .bucket(bucketName)
      .getFiles({ prefix: uploadsPrefix });
    return files.map((file) => {
      const entityId = file.name.startsWith(basePrefix ? `${basePrefix}/` : "")
        ? file.name.slice(basePrefix ? basePrefix.length + 1 : 0)
        : file.name;
      return {
        objectPath: `/objects/${entityId}`,
        createdAt: file.metadata.timeCreated
          ? new Date(file.metadata.timeCreated as string)
          : new Date(),
        remove: async () => {
          await file.delete({ ignoreNotFound: true });
        },
      };
    });
  }
}

function parseObjectPath(path: string): {
  bucketName: string;
  objectName: string;
} {
  if (!path.startsWith("/")) path = `/${path}`;
  const parts = path.split("/");
  if (parts.length < 3) {
    throw new Error("Invalid path: must contain at least a bucket name");
  }
  return { bucketName: parts[1], objectName: parts.slice(2).join("/") };
}

async function signObjectURL({
  bucketName,
  objectName,
  method,
  ttlSec,
}: {
  bucketName: string;
  objectName: string;
  method: "GET" | "PUT" | "DELETE" | "HEAD";
  ttlSec: number;
}): Promise<string> {
  const response = await fetch(
    `${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bucket_name: bucketName,
        object_name: objectName,
        method,
        expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Failed to sign object URL: ${response.status}`);
  }
  const body = (await response.json()) as { signed_url: string };
  return body.signed_url;
}
