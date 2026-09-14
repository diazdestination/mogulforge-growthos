import { describe, expect, it } from "vitest";
import { detectSchemaPushFailure } from "./release-schema.mjs";

describe("release schema output guard", () => {
  it("accepts ordinary successful drizzle output", () => {
    expect(
      detectSchemaPushFailure(
        "[✓] Pulling schema from database...\nChanges applied",
      ),
    ).toBeNull();
  });

  it("detects a database error even when drizzle exits successfully", () => {
    expect(
      detectSchemaPushFailure(
        "\u001b[34minfo\u001b[0m error: insert or update violates foreign key constraint",
      ),
    ).toBe("database error reported by drizzle-kit");
  });

  it("detects the PostgreSQL error object emitted by drizzle", () => {
    expect(detectSchemaPushFailure("severity: 'ERROR',\ncode: '23503'")).toBe(
      "PostgreSQL reported ERROR severity",
    );
  });
});
