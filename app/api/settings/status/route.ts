import { requireSession } from '@/lib/session';
import { ok, handleError } from '@/lib/api';
import { getSettings, publicOrigin } from '@/lib/settings';
import { isMailConfigured } from '@/lib/mail/config';

/** Was andere Seiten wissen müssen, bevor sie etwas anbieten, das an Adresse oder Mailversand hängt. */
export async function GET() {
  try {
    await requireSession();
    const settings = await getSettings();
    return ok({ publicUrl: publicOrigin(settings), mailConfigured: isMailConfigured(settings) });
  } catch (err) {
    return handleError(err);
  }
}
