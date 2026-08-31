/**
 * The one place that knows how to address a stored artefact.
 *
 * Artefacts are served from our own domain (app/api/document/view) rather than a
 * signed storage URL, because Supabase Storage overrides the content type of
 * stored .html with text/plain. Callers hand the browser what this returns; they
 * never build the path themselves.
 */
export type ArtefactKind = 'studypack-html' | 'studypack-pdf' | 'worksheet' | 'planner';

export function viewUrl(kind: ArtefactKind, id: string): string {
  return `/api/document/view?kind=${kind}&id=${encodeURIComponent(id)}`;
}
