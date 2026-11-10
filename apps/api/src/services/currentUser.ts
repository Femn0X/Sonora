import { prisma } from "./prisma";
import { DEMO_USER } from "./demoUser";

/** An Error carrying an HTTP status; the global error handler in server.ts turns `statusCode` into the response. */
class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

type RequestLike = { headers: Record<string, string | string[] | undefined> };

/** The id from the `x-user-id` header, if one was sent. */
function requestedUserId(req: RequestLike): string | null {
  const header = req.headers["x-user-id"];
  const id = (Array.isArray(header) ? header[0] : header)?.trim();
  return id ? id : null;
}

/**
 * In development the demo user is created on demand so a fresh database "just works". Production never
 * auto-creates accounts: there the user must already exist (seed it, or sign in once real auth lands).
 */
const AUTO_CREATE_DEMO_USER = process.env.NODE_ENV !== "production";

async function demoUserId(): Promise<string> {
  const existing = await prisma.user.findUnique({ where: { username: DEMO_USER.username }, select: { id: true } });
  if (existing) return existing.id;

  if (!AUTO_CREATE_DEMO_USER) {
    throw new HttpError(401, `The demo user doesn't exist in this database. Run "pnpm --filter @sonora/api db:seed" to create it.`);
  }
  try {
    const created = await prisma.user.create({ data: { ...DEMO_USER }, select: { id: true } });
    return created.id;
  } catch (error) {
    if ((error as { code?: string }).code !== "P2002") throw error;
    // Unique violation: another request created it a moment ago (fine), or a DIFFERENT account owns the email.
    const raced = await prisma.user.findUnique({ where: { username: DEMO_USER.username }, select: { id: true } });
    if (raced) return raced.id;
    throw new HttpError(
      409,
      `Can't create the built-in demo user: the email "${DEMO_USER.email}" is already used by another account. ` +
        `Give that account a different email, or send an existing user's id in the x-user-id header.`,
    );
  }
}

/**
 * Resolve the caller to the id of a user that EXISTS in the database. Always `await` it.
 *
 * Use this in every handler that writes rows referencing a user. Otherwise the insert fails with a raw
 * foreign-key error ("projects_ownerId_fkey") instead of a meaningful response. The check runs on every call,
 * not once at startup, so it also survives resetting the database while the dev server is running.
 */
export async function requireUser(req: RequestLike): Promise<string> {
  const id = requestedUserId(req);
  if (id === null) return demoUserId();

  const user = await prisma.user.findUnique({ where: { id }, select: { id: true } });
  if (!user) throw new HttpError(401, `Unknown user "${id}". The x-user-id header must be the id of an existing user.`);
  return user.id;
}
