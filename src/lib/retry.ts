export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  baseDelay: number = 1000
): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const isRateLimit = error?.status === 429 || error?.statusCode === 429;
      const isServerError = error?.status >= 500 || error?.statusCode >= 500;

      if ((isRateLimit || isServerError) && attempt < maxAttempts - 1) {
        const retryAfter = error?.headers?.["retry-after"];
        const delay = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : baseDelay * Math.pow(2, attempt);
        console.log(
          `Retry ${attempt + 1}/${maxAttempts} after ${delay}ms (${isRateLimit ? "rate limit" : "server error"})`
        );
        await sleep(delay);
      } else {
        throw error;
      }
    }
  }
  throw new Error("Unreachable");
}

// Notion API rate limiter: 3 requests per second
export class RateLimiter {
  private timestamps: number[] = [];
  private readonly maxPerSecond: number;

  constructor(maxPerSecond: number = 3) {
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
  if (!process.env.CRON_SECRET) return true; // No secret = allow (dev mode)
  return authHeader === `Bearer ${process.env.CRON_SECRET}`;
}
