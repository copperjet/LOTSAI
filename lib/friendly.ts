/**
 * What a teacher is told when something fails.
 *
 * The routes answer with a short code — `render_failed`, `stale_refs` — and
 * before this module those codes were printed into the conversation as they
 * stood, alongside whatever text Supabase Storage or the Google Drive client
 * happened to throw. That is a developer reading a log, not a teacher between
 * lessons.
 *
 * Addendum D9 rule 3 still holds: a failure names its cause and the next
 * action. It just does it in words the staffroom uses. The unabridged text is
 * not lost — it goes to /admin, which is where someone can act on it.
 */
const PLAIN: Record<string, string> = {
  ask_failed: 'I could not work that out just now. Try asking again in a moment.',
  blocked: 'This cannot go ahead yet.',
  generate_failed: 'The lesson could not be written just now. Try again in a moment.',
  improve_failed: 'That slide could not be rewritten just now. It is unchanged - try again in a moment.',
  last_slide: 'A lesson needs at least one slide.',
  lesson_unavailable: 'Lessons are not switched on for this school yet. An administrator needs to apply the database update.',
  no_class: 'Choose a class, or say which subject and year group the lesson is for.',
  no_such_slide: 'That slide is no longer in the lesson.',
  no_topic: 'Say what the lesson is about.',
  not_yours: 'That is not yours to change.',
  revise_failed: 'Nothing could be rewritten just now. The lesson is unchanged - try again in a moment.',
  save_failed: 'That did not save. Your work is still on the screen - try again in a moment.',
  unknown_class: 'That class is not one the school has on record.',
  closed: 'This is closed and can no longer be changed.',
  draw_failed: 'The picture could not be drawn just now. The slide is unchanged.',
  no_room: 'That slide has no room for a picture without losing what the class is asked to do.',
  drive_failed: 'It is saved here, but it could not be copied to the school Drive yet. Someone has been told.',
  empty: 'That cannot be left empty.',
  field: 'That part cannot be changed here.',
  no_folder: 'There is no Drive folder set up for this class yet. Ask the school office to add one.',
  not_signed_off: 'This is waiting to be signed off for the semester.',
  not_open: 'This is no longer open for editing.',
  nothing_resolved: 'Nothing in that file matched this class\u2019s curriculum, so there is nothing to build from.',
  render_failed: 'The printable version could not be made. Your work is saved \u2014 try again in a moment.',
  stale_refs: 'The curriculum has changed since this was made. Start it again so it picks up the new week.',
};

const LAST_RESORT = 'Something went wrong at our end. Your work is saved \u2014 try again in a moment.';

/**
 * Never returns the code itself. An unrecognised one is our omission, not the
 * teacher's problem, so it reads as the general apology rather than as a
 * string nobody outside this repository can parse.
 */
export function friendly(code?: string | null): string {
  return (code && PLAIN[code]) || LAST_RESORT;
}
