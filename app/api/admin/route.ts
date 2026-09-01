import { NextRequest, NextResponse } from 'next/server';
import { admin, currentUser, audit } from '@/lib/supabase';
import { ADMIN_ROLES, ROLES } from '@/lib/admin';

export const runtime = 'nodejs';

/**
 * POST /api/admin — the things the dashboard can change.
 *
 * A plain form POST, so the admin pages stay server components with no client
 * JavaScript, the same way the two doors do.
 *
 * The role is checked here as well as in the layout. The layout guards what is
 * rendered; this guards what is done, and a route that trusts the page that
 * linked to it is not guarded at all.
 *
 * Everything that used to need the seed script or the SQL editor is here: making
 * an account, changing a role, putting a teacher in front of a class, and saying
 * which of two conflicting overview files is the current one. Each one is written
 * to the audit log, because "who made this person a head of department" is a
 * question a school eventually asks.
 */

/** A problem the form has to report back. Rendered by the page that posted. */
type Problem =
  | 'bad_email' | 'duplicate_email' | 'bad_role' | 'missing' | 'self_role';

export async function POST(req: NextRequest) {
  const user = await currentUser();
  if (!ADMIN_ROLES.includes(user.role)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const form = await req.formData();
  const action = String(form.get('action') ?? '');
  const userId = String(form.get('userId') ?? '');
  const str = (k: string) => String(form.get(k) ?? '').trim();
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
    case 'unlock': {
      // A lockout clears itself after fifteen minutes. This is for the teacher
      // standing at the desk now, and it leaves their PIN alone.
      await db.from('app_user')
        .update({ failed_attempts: 0, locked_until: null }).eq('id', userId);
      await audit(user.id, 'admin.unlock', 'app_user', userId);
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
    case 'create_person': {
      const email = str('email').toLowerCase();
      const fullName = str('full_name');
      const role = str('role');
      const department = str('department') || null;

      if (!fullName || !email) return back(req, 'missing');
      if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) return back(req, 'bad_email');
      if (!ROLES.includes(role)) return back(req, 'bad_role');

      // No PIN is set here: the first sign-in chooses one, which is the path
      // everybody else took and the only one where nobody but they know it.
      const { error } = await db.from('app_user')
        .insert({ email, full_name: fullName, role, department });
      if (error) return back(req, 'duplicate_email');

      await audit(user.id, 'admin.create_person', 'app_user', email, { role, department });
      break;
    }
    case 'set_role': {
      const role = str('role');
      if (!ROLES.includes(role)) return back(req, 'bad_role');
      // Nobody changes their own role, which is what keeps an administrator from
      // demoting themselves out of this page by accident. It is also what keeps
      // the school from having no administrator at all: whoever is doing this is
      // one, and they cannot take it off themselves, so one always remains.
      if (userId === user.id) return back(req, 'self_role');

      const { data: was } = await db.from('app_user').select('role').eq('id', userId).maybeSingle();
      await db.from('app_user').update({ role }).eq('id', userId);
      await audit(user.id, 'admin.set_role', 'app_user', userId, { from: was?.role ?? null, to: role });
      break;
    }
    case 'set_department': {
      const department = str('department') || null;
      await db.from('app_user').update({ department }).eq('id', userId);
      await audit(user.id, 'admin.set_department', 'app_user', userId, { department });
      break;
    }
    case 'assign_class': {
      // A class with no teacher generates nothing and appears on nobody's agenda,
      // which is a silent failure until somebody asks why a week was never planned.
      const classId = str('classId');
      const teacherId = str('teacherId');
      if (!classId) return back(req, 'missing');
      await db.from('klass').update({ teacher_id: teacherId || null }).eq('id', classId);
      await audit(user.id, 'admin.assign_class', 'klass', classId, { teacherId: teacherId || null });
      break;
    }
    case 'resolve_gap': {
      // Which of two files is the current one. The importer reads these decisions
      // back and honours them on its next run, so this records the decision rather
      // than rewriting the registry underneath anybody. The page says as much.
      const gapId = str('gapId');
      const resolvedFile = str('resolvedFile');
      if (!gapId || !resolvedFile) return back(req, 'missing');
      await db.from('registry_gap').update({
        resolved_file: resolvedFile, resolved_by: user.id, resolved_at: new Date().toISOString(),
      }).eq('id', gapId);
      await audit(user.id, 'admin.resolve_gap', 'registry_gap', gapId, { file: resolvedFile });
      break;
    }
    default:
      return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  }

  return back(req);
}

function back(req: NextRequest, problem?: Problem) {
  const referer = req.headers.get('referer');
  const origin = new URL(req.url).origin;
  const url = referer && referer.startsWith(origin)
    ? new URL(referer) : new URL('/admin/people', req.url);
  url.searchParams.delete('e');
  if (problem) url.searchParams.set('e', problem);
  return NextResponse.redirect(url, 303);
}
