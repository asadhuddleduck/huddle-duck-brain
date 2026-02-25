// src/lib/hash.ts — Shared content hashing utility
import { createHash } from "crypto";

/** SHA-256 hash of text content, used for delta sync and chunk deduplication */
export function hashContent(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
