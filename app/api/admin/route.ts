import { NextRequest, NextResponse } from 'next/server';
import { admin, currentUser, audit } from '@/lib/supabase';
import { ADMIN_ROLES } from '@/lib/admin';

export const runtime = 'nodejs';

/**
 * POST /api/admin — the few things the dashboard can change.
 *
 * A plain form POST, so the admin pages stay server components with no client
 * JavaScript, the same way the two doors do.
 *
 * The role is checked here as well as in the layout. The layout guards what is
 * rendered; this guards what is done, and a route that trusts the page that
 * linked to it is not guarded at all.
 */
export async function POST(req: NextRequest) {
  const user = await currentUser();
  if (!ADMIN_ROLES.includes(user.role)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const form = await req.formData();
  const action = String(form.get('action') ?? '');
  const userId = String(form.get('userId') ?? '');
  const db = admin();

  switch (action) {
    case 'revoke_session': {
      const sessionId = String(form.get('sessionId') ?? '');
      await db.from('user_session').delete().eq('id', sessionId);
      await audit(user.id, 'admin.revoke_session', 'app_user', userId, { sessionId });
      break;
    }
    case 'reset_pin': {
      // Cleared, never set for them: an administrator who can choose somebody
      // else's PIN can sign in as them, and the whole point of sign-in is that
      // nobody can do that any more. Their sessions go too, or the old device
      // stays signed in through the reset.
      await db.from('app_user')
        .update({ pin_hash: null, pin_set_at: null, failed_attempts: 0, locked_until: null })
        .eq('id', userId);
      await db.from('user_session').delete().eq('user_id', userId);
      await audit(user.id, 'admin.reset_pin', 'app_user', userId);
      break;
    }
    case 'deactivate':
    case 'reactivate': {
      if (userId === user.id) break;   // the layout hides it; this makes it true
      const active = action === 'reactivate';
      await db.from('app_user').update({ is_active: active }).eq('id', userId);
      if (!active) await db.from('user_session').delete().eq('user_id', userId);
      await audit(user.id, `admin.${action}`, 'app_user', userId);
      break;
    }
    default:
      return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  }

  const back = req.headers.get('referer');
  return NextResponse.redirect(
    back && back.startsWith(new URL(req.url).origin) ? back : new URL('/admin/people', req.url), 303);
}
