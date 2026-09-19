import { CREST } from '@/lib/crest';
import Sprout from './Sprout';

/**
 * The door: who are you, personally.
 *
 * This says which member of staff you are, which is what makes ai_usage.user_id
 * and audit_log.actor_id mean anything.
 *
 * It used to be a name chosen from a list of every active member of staff, which
 * was the shortest path for the two of sixteen staff who rate themselves Beginner
 * on computer literacy - and which published the school's whole staff list to
 * anybody who reached the page, alongside a form for claiming any account that had
 * not set a PIN yet. So it is a school email address and a PIN now. The address is
 * one thing every teacher already knows by heart, and typing it tells a stranger
 * nothing.
 *
 * Both PIN fields are always shown, and the second is optional. The page cannot ask
 * the database whether this address is a staff account without answering that
 * question for whoever typed it, so it does not ask: /api/signin ignores the second
 * field when a PIN is already set, and a first-time teacher fills both. That is why
 * the wording says "first time only" rather than branching on anything.
 *
 * A plain form, no client JavaScript, so it works on a slow phone on school wifi.
 */
export default async function SignIn({ searchParams }: {
  searchParams: Promise<{ e?: string; next?: string; who?: string }>;
}) {
  const { e, next, who } = await searchParams;

  // Every failure says the same thing. Telling "no such address" apart from "wrong
  // PIN" apart from "locked" is how somebody finds out which addresses are real
  // accounts, and getting one locked is how they confirm it. /api/signin answers
  // all three identically and after the same delay for the same reason.
  const message =
    e === 'wrong' || e === 'nobody' || e === 'locked' || e === 'mismatch' || e === 'shape'
      ? 'That did not work. Check your school email address and your PIN, and note that '
        + 'five wrong tries locks the account for a quarter of an hour.'
      : null;

  return (
    <div className="gatepage">
      <Sprout />

      <form className="gatecard" method="post" action="/api/signin">
        <img src={CREST} alt="Lusaka Oaktree School" />
        <h1>Sign in</h1>
        <p>Your school email address, and your PIN. The first time, choose a PIN and
           type it twice - you will use it every time after that.</p>

        <input type="hidden" name="next" value={next ?? '/'} />
        <input type="email" name="who" defaultValue={who ?? ''} autoComplete="username"
               autoFocus required spellCheck={false}
               placeholder="you@lusakaoaktree.school" aria-label="Your school email address" />
        <input type="password" name="pin" inputMode="numeric" autoComplete="current-password"
               pattern="[0-9]{4,8}" required
               title="Use numbers only (0-9), 4 to 8 digits. No letters or spaces."
               placeholder="PIN" aria-label="Your PIN" />
        <input type="password" name="again" inputMode="numeric" autoComplete="off"
               pattern="[0-9]{4,8}"
               title="Use numbers only (0-9), 4 to 8 digits. No letters or spaces."
               placeholder="Same PIN again - first time only"
               aria-label="Repeat your PIN, only needed the first time" />

        <button className="btn primary" type="submit">Continue</button>
        {message && <p className="gerr">{message}</p>}
      </form>
    </div>
  );
}
