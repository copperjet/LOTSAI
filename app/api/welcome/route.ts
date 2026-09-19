import { NextRequest, NextResponse } from 'next/server';
import { admin, currentUser, audit } from '@/lib/supabase';
import { ALL_CLASSES_ROLES } from '@/lib/admin';

export const runtime = 'nodejs';

/**
 * POST /api/welcome  { classId: [...] }
 *
 * What the teacher ticked on /welcome, written to class_teacher.
 *
 * It replaces their allocations rather than adding to them, because the form is the
 * whole list and an unticked box means "not mine any more". Only their own rows are
 * touched - the delete is keyed on user_id - so a colleague sharing a class keeps it.
 *
 * A plain form POST, so this redirects rather than returning JSON.
 */

/** A form carrying more class ids than the school has classes is a mistake or a probe. */
const MAX_CLASSES = 60;

export async function POST(req: NextRequest) {
  const db = admin();
  const user = await currentUser();

  // Nothing to choose, so nothing to save. Not an error - a reviewer who followed a
  // stale link should land on the front page like anybody else.
  if (ALL_CLASSES_ROLES.includes(user.role)) {
    return NextResponse.redirect(new URL('/', req.url), 303);
  }

  const form = await req.formData();
  const asked = [...new Set(form.getAll('classId').map(String).filter(Boolean))];

  if (asked.length > MAX_CLASSES) {
    return NextResponse.redirect(new URL('/welcome?e=too_many', req.url), 303);
  }

  // Only ids that are real classes. A checkbox value is whatever was posted, and a
  // row referencing a class that does not exist would fail the foreign key anyway -
  // this fails it as a message rather than as a 500.
  const { data: real } = asked.length
    ? await db.from('klass').select('id').in('id', asked)
    : { data: [] as { id: string }[] };
  const ids = (real ?? []).map(k => k.id);

  const { error: gone } = await db.from('class_teacher').delete().eq('user_id', user.id);
  if (gone) return NextResponse.redirect(new URL('/welcome?e=save', req.url), 303);

  if (ids.length) {
    const { error } = await db.from('class_teacher')
      .upsert(ids.map(class_id => ({ class_id, user_id: user.id })),
              { onConflict: 'class_id,user_id' });
    if (error) return NextResponse.redirect(new URL('/welcome?e=save', req.url), 303);
  }

  await audit(user.id, 'classes.selected', 'class_teacher', user.id, { classes: ids });

  return NextResponse.redirect(new URL('/', req.url), 303);
}
