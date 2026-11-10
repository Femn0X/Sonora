/**
 * Shared client for calls to the Sonora API (the separate Fastify server,
 * NOT the Next.js app's own origin).
 *
 * Bug this fixes: components were calling `fetch('/api/v1/...')` with a
 * relative path, which resolves against the Next.js dev server's own origin
 * (localhost:3000) since there is no Next API route or rewrite at that path.
 * The request 404s against Next's router, and the response body is Next's
 * full HTML 404 page rather than JSON — which then gets thrown wholesale as
 * an Error message, producing the huge unreadable blob seen in the console.
 *
 * Fix: give every API call an explicit, configurable base URL, and parse
 * error responses as JSON when possible instead of dumping raw bodies.
 */

export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function apiFetch<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });

  if (!res.ok) {
    // Try to extract a clean message from a JSON error body (Fastify's
    // default error shape is { message, error, statusCode }); fall back to
    // a short generic message rather than ever throwing an entire HTML page.
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (typeof body?.message === "string") message = body.message;
    } catch {
      // Response wasn't JSON (e.g. hit the wrong server/route) — keep the
      // generic message instead of dumping raw HTML into the thrown error.
    }
    throw new ApiError(message, res.status);
  }

  return res.json() as Promise<T>;
}
