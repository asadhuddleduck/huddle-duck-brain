// src/lib/retry.ts — Retry, rate limiting, and request auth utilities
import { timingSafeEqual } from "crypto";
import {
  DEFAULT_MAX_RETRY_ATTEMPTS,
  DEFAULT_RETRY_BASE_DELAY_MS,
} from "./constants";

interface RetryableError {
  status?: number;
  statusCode?: number;
  headers?: Record<string, string>;
  message?: string;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number = DEFAULT_MAX_RETRY_ATTEMPTS,
  baseDelay: number = DEFAULT_RETRY_BASE_DELAY_MS
): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      const err = error as RetryableError;
      const isRateLimit = err?.status === 429 || err?.statusCode === 429;
      const isServerError =
        (err?.status !== undefined && err.status >= 500) ||
        (err?.statusCode !== undefined && err.statusCode >= 500);

      if ((isRateLimit || isServerError) && attempt < maxAttempts - 1) {
        const retryAfter = err?.headers?.["retry-after"];
        const delay = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : baseDelay * Math.pow(2, attempt);
        console.log(
          `[retry] Attempt ${attempt + 1}/${maxAttempts} after ${delay}ms (${isRateLimit ? "rate limit" : "server error"})`
        );
        await sleep(delay);
      } else {
        throw error;
      }
    }
  }
  throw new Error("Unreachable: retry loop exhausted without returning or throwing");
}

/** Notion API rate limiter: enforces max N requests per second */
export class RateLimiter {
  private timestamps: number[] = [];
  private readonly maxPerSecond: number;

  constructor(maxPerSecond: number) {
    this.maxPerSecond = maxPerSecond;
  }

  async acquire(): Promise<void> {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < 1000);

    if (this.timestamps.length >= this.maxPerSecond) {
      const oldestInWindow = this.timestamps[0];
      const waitTime = 1000 - (now - oldestInWindow) + 10;
      await sleep(waitTime);
      return this.acquire();
    }

    this.timestamps.push(Date.now());
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    return withRetry(fn);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function verifyCronSecret(authHeader: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // In production, CRON_SECRET must be set. Reject if missing.
    if (process.env.NODE_ENV === "production" || process.env.VERCEL) {
      console.error("[auth] CRON_SECRET is not set in production — rejecting request");
      return false;
    }
    // Dev mode: allow without secret
    return true;
  }
  const expected = `Bearer ${secret}`;
  if (!authHeader) return false;
  try {
    return timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Verify bearer token auth for API endpoints.
 * Uses CRON_SECRET as the shared secret (same token for cron + API access).
 */
export function verifyApiAuth(req: Request): boolean {
  const authHeader = req.headers.get("authorization");
  return verifyCronSecret(authHeader);
}

/**
 * Sanitize error messages for external responses.
 * Strips stack traces, file paths, and internal details.
 */
export function sanitizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cleaned = error.message
      // Strip file paths (Unix and Windows)
      .replace(/\/[^\s:]+\.(ts|js|tsx|jsx)/g, "[internal]")
      .replace(/[A-Z]:\\[^\s:]+\.(ts|js|tsx|jsx)/g, "[internal]")
      // Strip stack trace markers
      .replace(/\s+at\s+.+/g, "")
      // Limit length
      .slice(0, 200);
    return cleaned || "Internal server error";
  }
  return "Internal server error";
}
