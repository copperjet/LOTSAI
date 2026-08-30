/**
 * The implementation registry.
 *
 * A Standard (the DB record) names its generator, gate and renderer by string id.
 * This file is where those ids resolve to code. Adding a workflow means writing a
 * Standard record and, if it needs new behaviour, registering an implementation
 * here — never a new route. Reusing an existing one (a second artefact that gates
 * the same way) costs nothing.
 *
 * The engine (lib/engine.ts) only ever dispatches through these maps; it never
 * imports a workflow's functions directly. That indirection is the whole point —
 * it is what lets one pipeline run many workflows.
 */
import { generatePlan, type GenerateInput } from '@/lib/planner';
import { runGate } from '@/lib/gate';
import { buildGateInput } from '@/lib/gateContext';
import { renderPlanner } from '@/lib/pdf/renderers/planner';
import { generateStudyPack, gateStudyPack, type GeneratePackInput } from '@/lib/studypack';
import { renderStudyPack } from '@/lib/studypack_render';
import { renderStudyPackPdf } from '@/lib/pdf/renderers/studypack';
import { generateWorksheet, gateWorksheet, type GenerateWorksheetInput } from '@/lib/worksheet';
import { renderWorksheet } from '@/lib/pdf/renderers/worksheet';

/** A generator turns assembled grounding into artefact content. The input and the
 *  output are the workflow's own; the engine passes them through, only requiring a
 *  usage figure to meter. */
export type Generator = (input: unknown, userId: string) => Promise<{ usage: unknown } & Record<string, unknown>>;

/** A gate scores an artefact already written to the database, by its id. */
export type GateFn = (docId: string, userId: string) => Promise<{
  checks: unknown[]; blocking: number; warnings: number; passed: number;
}>;

/** A renderer draws a stored artefact to bytes (PDF or HTML). */
export type Renderer = (docId: string) => Promise<Uint8Array>;

export const GENERATORS: Record<string, Generator> = {
  planner: (input, userId) => generatePlan(input as GenerateInput, userId),
  studypack: (input, userId) => generateStudyPack(input as GeneratePackInput, userId),
  worksheet: (input, userId) => generateWorksheet(input as GenerateWorksheetInput, userId),
};

export const GATES: Record<string, GateFn> = {
  // The planner gate needs its input assembled from the DB first (lib/gateContext).
  planner: async (plannerId, userId) => runGate(await buildGateInput(plannerId), userId),
  studypack: (studyPackId) => gateStudyPack(studyPackId),
  worksheet: (worksheetId) => gateWorksheet(worksheetId),
};

export const RENDERERS: Record<string, Renderer> = {
  planner: (plannerId) => renderPlanner(plannerId),
  studypack: (studyPackId) => renderStudyPack(studyPackId),
  'studypack-pdf': (studyPackId) => renderStudyPackPdf(studyPackId),
  worksheet: (worksheetId) => renderWorksheet(worksheetId),
};
