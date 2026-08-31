import { admin } from '@/lib/supabase';
import { CREST } from '@/lib/crest';
import Sprout from '../gate/Sprout';

/**
 * The second door: who are you, personally.
 *
 * The school password says the visitor belongs to the school. This says which
 * member of staff they are, which is what makes ai_usage.user_id and
 * audit_log.actor_id mean anything.
 *
 * A name from a list plus a PIN, rather than an email and a password: two of
 * sixteen staff rate themselves Beginner on computer literacy, and picking your
 * own name off a list is the shortest path there is. The list is names only —
 * no email addresses — and it is behind the school password, so it tells a
 * stranger nothing they could not read on a classroom door.
 *
 * A plain form, no client JavaScript, like the gate.
 */
export default async function SignIn({ searchParams }: {
  searchParams: Promise<{ e?: string; next?: string; who?: string }>;
}) {
  const { e, next, who } = await searchParams;

  const { data } = await admin().from('app_user')
    .select('id, full_name, pin_hash, is_active')
    .order('full_name');

  const people = (data ?? []).filter(p => p.is_active !== false) as
    { id: string; full_name: string; pin_hash: string | null }[];

  // Chosen already? Then we know whether they are setting a PIN or entering one.
  const chosen = people.find(p => p.id === who);
  const setting = chosen ? !chosen.pin_hash : false;

  const message =
    e === 'wrong' ? 'That PIN is not right.'
    : e === 'locked' ? 'Too many tries. Wait a quarter of an hour and try again.'
    : e === 'shape' ? 'Your PIN needs to be 4 to 8 numbers.'
    : e === 'mismatch' ? 'Those two PINs are not the same.'
    : e === 'nobody' ? 'Choose your name from the list.'
    : null;

  return (
    <div className="gatepage">
      <Sprout />

      {!chosen ? (
        <form className="gatecard" method="get" action="/signin">
          <img src={CREST} alt="Lusaka Oaktree School" />
          <h1>Who is this?</h1>
          <input type="hidden" name="next" value={next ?? '/'} />
          <select name="who" className="gatesel" defaultValue="" aria-label="Your name" required>
            <option value="" disabled>Choose your name</option>
            {people.map(p => <option key={p.id} value={p.id}>{p.full_name}</option>)}
          </select>
          <button className="btn primary" type="submit">Continue</button>
          {message && <p className="gerr">{message}</p>}
        </form>
      ) : (
        <form className="gatecard" method="post" action="/api/signin">
          <img src={CREST} alt="Lusaka Oaktree School" />
          <h1>{chosen.full_name}</h1>
          <p>{setting
            ? 'Choose a PIN. You will use it every time you sign in on this device.'
            : 'Enter your PIN.'}</p>

          <input type="hidden" name="who" value={chosen.id} />
          <input type="hidden" name="next" value={next ?? '/'} />
          <input type="password" name="pin" inputMode="numeric" autoComplete="off"
                 pattern="[0-9]*" autoFocus required
                 placeholder={setting ? 'New PIN' : 'PIN'} aria-label={setting ? 'New PIN' : 'PIN'} />
          {setting && (
            <input type="password" name="again" inputMode="numeric" autoComplete="off"
                   pattern="[0-9]*" required placeholder="Same PIN again" aria-label="Repeat your new PIN" />
          )}
          <button className="btn primary" type="submit">{setting ? 'Set it and continue' : 'Continue'}</button>
          {message && <p className="gerr">{message}</p>}
          <a className="gateback" href={`/signin?next=${encodeURIComponent(next ?? '/')}`}>Not you?</a>
        </form>
      )}
    </div>
  );
}
