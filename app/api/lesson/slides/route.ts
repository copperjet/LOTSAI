import { NextRequest, NextResponse } from 'next/server';
import { audit, currentUser } from '@/lib/supabase';
import { bandById } from '@/lib/lesson/ages';
import { checkDeck } from '@/lib/lesson/gate';
import { mayEdit, readLesson, saveDeck, snapshot } from '@/lib/lesson/persist';
import { accentFor, nextSlideId, repairDeck, settleTeacher } from '@/lib/lesson/repair';
import {
  LESSON_PHASES, PHASE_LABEL, type LessonPhase, type Slide,
} from '@/lib/lesson/schema';
import { THEMES } from '@/lib/studypack/themes';

export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * POST /api/lesson/slides
 *   { lessonId, action: 'move' | 'duplicate' | 'delete' | 'insert', slideId?, to?, phase? }
 *
 * The structural edits: reorder, duplicate, delete, add. All deterministic, all
 * free, all instant.
 *
 * Slide ids are never renumbered by any of these. It is tempting - after a move
 * the ids read out of order - but `assessment[].slide_id` points at them, the
 * editor holds the selected one, and the audit trail records them. Renumbering
 * would silently repoint every one of those at a different slide.
 */
export async function POST(req: NextRequest) {
  const user = await currentUser();
  const body = await req.json() as {
    lessonId?: string; action?: string; slideId?: string; to?: number; phase?: string;
    theme?: string;
  };

  const { lessonId, action, slideId } = body;
  if (!lessonId || !action) {
    return NextResponse.json({ error: 'lessonId and action are required' }, { status: 400 });
  }

  const row = await readLesson(lessonId);
  if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!mayEdit(row, user)) return NextResponse.json({ error: 'not_yours' }, { status: 403 });
  if (row.approved) {
    return NextResponse.json({
      error: 'not_open',
      message: 'This lesson is approved and in the shared bank. Ask for it to be returned before '
        + 'changing it.',
    }, { status: 409 });
  }

  const deck = row.content;
  const at = slideId ? deck.slides.findIndex(s => s.id === slideId) : -1;

  switch (action) {
    case 'move': {
      if (at < 0) return NextResponse.json({ error: 'no_such_slide' }, { status: 404 });
      const to = Math.min(deck.slides.length - 1, Math.max(0, Math.round(Number(body.to))));
      if (!Number.isInteger(to)) {
        return NextResponse.json({ error: 'to must be a position' }, { status: 400 });
      }
      const [moved] = deck.slides.splice(at, 1);
      deck.slides.splice(to, 0, moved);
      break;
    }

    case 'duplicate': {
      if (at < 0) return NextResponse.json({ error: 'no_such_slide' }, { status: 404 });
      // A deep copy, or the two slides share their blocks and editing one edits
      // both - which looks exactly like a bug in the editor.
      const copy = JSON.parse(JSON.stringify(deck.slides[at])) as Slide;
      copy.id = nextSlideId(deck.slides);
      deck.slides.splice(at + 1, 0, copy);
      break;
    }

    case 'delete': {
      if (at < 0) return NextResponse.json({ error: 'no_such_slide' }, { status: 404 });
      if (deck.slides.length <= 1) {
        return NextResponse.json({
          error: 'last_slide',
          message: 'A lesson needs at least one slide.',
        }, { status: 409 });
      }
      // The one structural edit that destroys work, so the one that keeps a copy
      // first. A move or a duplicate is undone by hand; a deleted slide's content
      // and teaching notes are not. The first run of this deleted a slide by
      // mistake and the only way back was to the deck as generated.
      await snapshot(lessonId, deck, `deleted slide ${at + 1}: ${deck.slides[at].title}`, user.id);
      deck.slides.splice(at, 1);
      break;
    }

    case 'insert': {
      const phase = (LESSON_PHASES as readonly string[]).includes(String(body.phase))
        ? body.phase as LessonPhase : 'explanation';
      const blank: Slide = {
        id: nextSlideId(deck.slides),
        phase,
        audience: 'teacher_led',
        eyebrow: null,
        title: 'New slide',
        // An empty purpose is what the gate blocks on, which is the point: a
        // slide added by hand has to earn its place like any other.
        purpose: '',
        minutes: 3,
        objective_indexes: [],
        blocks: [{ type: 'bullets', heading: null, items: ['Write the point here'] }],
        teacher: settleTeacher(null),
        accent: accentFor(phase),
        layout: 'bullets',
      };
      const where = Number.isFinite(body.to) ? Math.round(Number(body.to)) : at >= 0 ? at + 1 : deck.slides.length;
      deck.slides.splice(Math.min(deck.slides.length, Math.max(0, where)), 0, blank);
      break;
    }

    case 'theme': {
      // The theme was chosen automatically from the subject, which gives two
      // decks for the same class a family resemblance. A teacher who wants this
      // one to look different - or who is presenting in a bright room - picks.
      if (!THEMES.some(t => t.id === body.theme)) {
        return NextResponse.json({ error: 'unknown_theme' }, { status: 400 });
      }
      deck.theme = body.theme as string;
      break;
    }

    default:
      return NextResponse.json({ error: 'unknown_action' }, { status: 400 });
  }

  const band = bandById(deck.meta.ageBand);
  repairDeck(deck, band);

  const ok = await saveDeck(lessonId, deck, action === 'theme' ? { theme: deck.theme } : {});
  if (!ok) {
    return NextResponse.json({
      error: 'save_failed',
      message: 'That did not save. Try again in a moment.',
    }, { status: 502 });
  }

  await audit(user.id, `lesson.${action}`, 'lesson', lessonId, { slide: slideId ?? null });

  return NextResponse.json({
    ok: true,
    theme: deck.theme,
    slides: deck.slides,
    minutes: deck.slides.reduce((n, s) => n + s.minutes, 0),
    gate: checkDeck(deck, band),
  });
}

/** The phases a teacher may add a slide into, for the picker. */
export async function GET() {
  await currentUser();
  return NextResponse.json({
    phases: LESSON_PHASES.map(p => ({ id: p, label: PHASE_LABEL[p] })),
  });
}
