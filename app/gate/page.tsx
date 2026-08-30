import { CREST } from '@/lib/crest';

/**
 * The door. A plain form, posted to /api/gate — no client JavaScript, so it
 * works on a slow phone on school wifi.
 */
export default async function Gate({ searchParams }: {
  searchParams: Promise<{ e?: string; next?: string }>;
}) {
  const { e, next } = await searchParams;

  const message = e === 'unset'
    ? 'This deployment has no SITE_PASSWORD set, so nothing is being served. Set it in the hosting environment.'
    : e === 'wrong' ? 'That password is not right.'
    : null;

  return (
    <div className="gatepage">
      <form className="gatecard" method="post" action="/api/gate">
        <img src={CREST} alt="LOTS AI" />
        <h1>LOTS AI</h1>
        <p>Weekly planning and lesson evaluation, for Lusaka Oaktree School.</p>

        <input type="hidden" name="next" value={next ?? '/'} />
        <input type="password" name="password" autoFocus required
               autoComplete="current-password" placeholder="School password"
               aria-label="School password" disabled={e === 'unset'} />
        <button className="btn primary" type="submit" disabled={e === 'unset'}>Continue</button>

        {message && <p className="gerr">{message}</p>}

        <small>
          One shared password stands in for sign-in until Google Workspace SSO is switched on.
          Everyone who comes through it is signed in as the same demo user.
        </small>
      </form>
    </div>
  );
}
