/**
 * The workflow engine.
 *
 * One pipeline runs every workflow: resolve the workflow + its Standard, then
 * dispatch generation, gating and rendering through the registry (by the ids the
 * Standard carries). The planner routes call this instead of importing the
 * planner's functions directly — so the second artefact type reuses the same
 * machinery rather than copying a route.
 *
 * Tolerant of migration 0007 not yet being applied: when the workflow table has
 * no row, a built-in default for a known workflow is used, so the working loop
 * behaves identically before and after the engine's tables exist.
 */
import { admin } from './supabase';
import { GENERATORS, GATES, RENDERERS } from './workflows/registry';

export interface Standard {
  key: string; version: string; name: string;
  schema: Record<string, unknown>;
  non_negotiables: string[];
  generator_id: string; gate_id: string; renderer_id: string | null;
  tier: 'small' | 'standard' | 'large';
  render: Record<string, unknown>;
}

export interface Workflow {
  key: string; name: string; roles: string[];
  collaborative: { work_key?: string[]; on_match?: string[] };
  approval: { submit_to?: string; states?: string[] };
  render: { on?: string; to?: string; format?: string };
  standard: Standard;
}

/**
 * The one workflow that exists today, as code — the fallback used until 0007 and
 * the seed load it into the database. It names the same generator, gate and
 * renderer the seed writes, so resolving from either source yields the same run.
 */
const BUILTIN: Record<string, Workflow> = {
  weekly_planner: {
    key: 'weekly_planner', name: 'Weekly Planner', roles: ['teacher'],
    collaborative: { work_key: ['artefact_type', 'subject', 'year_group', 'academic_year', 'school_week', 'objective_set'], on_match: ['reuse', 'adapt'] },
    approval: { submit_to: 'hod', states: ['draft', 'submitted', 'reviewed', 'approved', 'returned'] },
    render: { on: 'approved', to: 'storage' },
    standard: {
      key: 'weekly_planner', version: 'v1', name: 'Weekly Planner',
      schema: {}, non_negotiables: [],
      generator_id: 'planner', gate_id: 'planner', renderer_id: 'planner',
      tier: 'standard', render: { page: 'A4' },
    },
  },
  study_pack: {
    key: 'study_pack', name: 'Study Pack', roles: ['teacher'],
    collaborative: { work_key: ['artefact_type', 'subject', 'year_group', 'academic_year', 'week_from', 'objective_set'], on_match: ['reuse'] },
    approval: { submit_to: 'hod', states: ['draft', 'submitted', 'approved', 'returned'] },
    render: { on: 'create', to: 'storage', format: 'html' },
    standard: {
      key: 'study_pack', version: 'v1', name: 'Study Pack',
      schema: {}, non_negotiables: [],
      generator_id: 'studypack', gate_id: 'studypack', renderer_id: 'studypack',
      tier: 'standard', render: { format: 'html' },
    },
  },
  homework: {
    key: 'homework', name: 'Homework', roles: ['teacher'],
    collaborative: { work_key: ['artefact_type', 'subject', 'year_group', 'academic_year', 'school_week', 'objective_set'], on_match: ['reuse'] },
    // Homework is a teaching aid the teacher who set it approves, as a worksheet is -
    // not a plan a head signs.
    approval: { submit_to: 'teacher', states: ['draft', 'approved', 'returned'] },
    render: { on: 'create', to: 'storage', format: 'html' },
    standard: {
      key: 'homework', version: 'v1', name: 'Homework',
      schema: {}, non_negotiables: [],
      generator_id: 'homework', gate_id: 'homework', renderer_id: 'homework',
      tier: 'standard', render: { format: 'html' },
    },
  },
  worksheet: {
    key: 'worksheet', name: 'Worksheet', roles: ['teacher'],
    collaborative: { work_key: ['artefact_type', 'subject', 'year_group', 'academic_year', 'school_week', 'objective_set'], on_match: ['reuse', 'adapt'] },
    // A worksheet is a teaching aid, not a plan a head signs — its author approves it (§ study-pack precedent).
    approval: { submit_to: 'teacher', states: ['draft', 'approved', 'returned'] },
    render: { on: 'create', to: 'storage', format: 'pdf' },
    standard: {
      key: 'worksheet', version: 'v1', name: 'Worksheet',
      schema: {}, non_negotiables: [],
      generator_id: 'worksheet', gate_id: 'worksheet', renderer_id: 'worksheet',
      tier: 'standard', render: { format: 'pdf' },
    },
  },
};

/** The artefact_type used in the work key, from the workflow (defaults to its key). */
export function artefactType(wf: Workflow): string {
  return wf.key === 'weekly_planner' ? 'planner' : wf.key;
}

/** Load a workflow and its Standard, falling back to the built-in when the tables
 *  are empty or absent. Never throws for a known built-in workflow. */
export async function resolveWorkflow(key: string): Promise<Workflow> {
  const db = admin();
  const { data: wf, error } = await db.from('workflow').select('*').eq('key', key).maybeSingle();
  if (error || !wf) {
    const builtin = BUILTIN[key];
    if (!builtin) throw new Error(`Unknown workflow '${key}' and no built-in fallback`);
    return builtin;
  }
  const { data: std } = await db.from('standard').select('*')
    .eq('key', wf.standard_key).eq('version', wf.standard_version).maybeSingle();
  // A workflow row without its standard is a broken load; fall back rather than
  // run a half-configured workflow.
  if (!std) return BUILTIN[key] ?? Promise.reject(new Error(`Standard ${wf.standard_key}@${wf.standard_version} missing`));
  return { ...wf, standard: std as Standard } as Workflow;
}

/** Dispatch generation to the Standard's registered generator. The input shape is
 *  the workflow's own — the engine passes it through untouched. */
export async function generate(std: Standard, input: unknown, userId: string) {
  const gen = GENERATORS[std.generator_id];
  if (!gen) throw new Error(`No generator registered for '${std.generator_id}'`);
  return gen(input, userId);
}

/** Dispatch gating to the Standard's registered gate (operates on the stored artefact). */
export async function gate(std: Standard, docId: string, userId: string) {
  const g = GATES[std.gate_id];
  if (!g) throw new Error(`No gate registered for '${std.gate_id}'`);
  return g(docId, userId);
}

/** Dispatch rendering to the Standard's registered renderer, if it has one. */
export async function render(std: Standard, docId: string): Promise<Uint8Array | null> {
  if (!std.renderer_id) return null;
  const r = RENDERERS[std.renderer_id];
  if (!r) throw new Error(`No renderer registered for '${std.renderer_id}'`);
  return r(docId);
}
