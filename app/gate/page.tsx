import { CREST } from '@/lib/crest';
import Sprout from './Sprout';

/**
 * The door. A plain form, posted to /api/gate — no client JavaScript in the
 * form itself, so it works on a slow phone on school wifi. Sprout behind it is
 * a separate component with its own guards, and the door is complete without
 * him.
 */
export default async function Gate({ searchParams }: {
  searchParams: Promise<{ e?: string; next?: string }>;
}) {
  const { e, next } = await searchParams;

  // Never name an environment variable to whoever is standing at the door. A
  // misconfigured deployment is our problem to fix, not theirs to diagnose.
  const message = e === 'unset'
    ? 'LOTS AI is not ready yet. Please tell the school office.'
    : e === 'wrong' ? 'That password is not right.'
    : null;

  return (
    <div className="gatepage">
      <Sprout />
      <form className="gatecard" method="post" action="/api/gate">
        <img src={CREST} alt="Lusaka Oaktree School" />
        <h1>LOTS AI</h1>

        <input type="hidden" name="next" value={next ?? '/'} />
        <input type="password" name="password" autoFocus required
               autoComplete="current-password" placeholder="School password"
               aria-label="School password" disabled={e === 'unset'} />
        <button className="btn primary" type="submit" disabled={e === 'unset'}>Continue</button>

        {message && <p className="gerr">{message}</p>}
      </form>
    </div>
  );
}
