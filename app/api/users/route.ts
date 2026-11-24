import { requireCsrf, requireSession } from '@/lib/session';
import { listUsers, createUser } from '@/lib/auth/users';
import { logAudit, getClientIP } from '@/lib/audit';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';

export async function GET() {
  try {
    await requireSession();
    return ok(await listUsers());
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();

    const { name, email, password } = await jsonBody<{ name?: unknown; email?: unknown; password?: unknown }>(request);
    if (typeof name !== 'string' || typeof email !== 'string' || typeof password !== 'string') {
      throw new ApiError(msg('Name, E-Mail und Passwort sind erforderlich.'));
    }

    const user = await createUser({ name, email, password });

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'user_created',
      resource: 'user',
      resourceId: user.$id,
      details: `${user.name} <${user.email}>`,
      ip: getClientIP(request),
    });

    return ok(user);
  } catch (err) {
    return handleError(err);
  }
}
