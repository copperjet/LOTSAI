/**
 * What a lesson in this subject looks like.
 *
 * A generic presentation generator writes the same slide for Mathematics and for
 * History: a heading and four bullets. The subjects do not teach that way. A
 * mathematics lesson is worked examples and notation; a history lesson is a
 * timeline and a source; a computing lesson is a flowchart and a screenshot of
 * the interface the class is looking at.
 *
 * So the subject is a table, not a prompt instruction, and it does two concrete
 * things: it narrows the block types the outline pass may choose from, and it
 * narrows the diagram kinds the fill pass may draw. A history lesson cannot be
 * given a number line by accident, because the schema it answers into does not
 * contain one.
 *
 * MATCHING. On subject.id first, then subject.name. Never on department:
 * app_user.department and the subject table's department are different free-text
 * vocabularies that do not join, so matching on department would put every
 * subject on the default profile and look like it was working.
 */
import type { DiagramKind, SlideBlockType } from './schema';

export interface SubjectProfile {
  id: string;
  name: string;
  /** Tested against subject.id, then subject.name. */
  match: RegExp;
  /** Reached for first. Ordered - the outline is told to prefer these in order. */
  prefer: SlideBlockType[];
  /** The only diagram kinds offered for this subject. */
  diagrams: DiagramKind[];
  /** Removed from the union entirely for this subject. */
  avoid: SlideBlockType[];
  /** One line, in the cached prefix. Written for the model, not for us. */
  note: string;
}

/** Ordered most specific first; `default` is last and matches everything. */
export const SUBJECT_PROFILES: SubjectProfile[] = [
  {
    id: 'mathematics', name: 'Mathematics',
    match: /\b(math|maths|mathematics|numeracy|algebra|geometry|statistics)\b/i,
    prefer: ['worked_example', 'steps', 'diagram', 'question', 'task', 'error_spot', 'chart'],
    diagrams: ['number_line', 'bar_model', 'grid', 'flow', 'labelled'],
    avoid: ['code', 'scenario'],
    note: 'Mathematics is taught by working an example in front of the class and then having them '
      + 'do one. Show the method step by step with the notation written properly, never as prose '
      + 'about the method. Follow a worked example with a question of the same shape. Use a number '
      + 'line, a bar model or a place-value grid where the structure is the point. Spotting the '
      + 'error in a wrong solution is worth more than another correct one.',
  },
  {
    id: 'computing', name: 'Computer Science and ICT',
    match: /\b(comput|ict|informat|programming|coding|software|digital)\b/i,
    prefer: ['diagram', 'code', 'steps', 'image', 'error_spot', 'task', 'compare'],
    diagrams: ['flow', 'tree', 'grid', 'labelled', 'cycle'],
    avoid: [],
    note: 'Computing is taught against something on the screen. An algorithm is a flowchart or '
      + 'numbered pseudocode, not a paragraph. A procedure in an application is the sequence of '
      + 'steps, and where the teacher has supplied a screenshot it belongs beside them. Show code '
      + 'as code. A broken program the class has to fix teaches more than a working one.',
  },
  {
    id: 'science', name: 'Science',
    match: /\b(science|biolog|chemis|physic)\b/i,
    prefer: ['diagram', 'predict', 'steps', 'table', 'chart', 'question', 'compare'],
    diagrams: ['labelled', 'cycle', 'flow', 'grid', 'venn'],
    avoid: ['code'],
    note: 'Science is taught through a diagram of the thing itself and a process that runs. Label '
      + 'the apparatus or the structure; show a cycle as a cycle. Ask the class to predict before '
      + 'you show the result, because a prediction they got wrong is the lesson. Where there is '
      + 'data, put it in a table or a chart and have them read it.',
  },
  {
    id: 'history', name: 'History',
    match: /\b(histor|civics|heritage)\b/i,
    prefer: ['diagram', 'image', 'compare', 'scenario', 'question', 'discuss', 'statement'],
    diagrams: ['timeline', 'flow', 'tree', 'venn'],
    avoid: ['code'],
    note: 'History is taught on a timeline and from a source. Put the events in order on a '
      + 'timeline so the class can see what followed what. Cause and effect is a chain, so draw it '
      + 'as one. Give them a short source and a question about it rather than a summary of the '
      + 'source. Two accounts that disagree are better than one that does not.',
  },
  {
    id: 'geography', name: 'Geography',
    match: /\b(geograph|environment)\b/i,
    prefer: ['diagram', 'chart', 'image', 'table', 'compare', 'question', 'scenario'],
    diagrams: ['labelled', 'flow', 'cycle', 'grid'],
    avoid: ['code'],
    note: 'Geography is taught from a map, a cross-section and a figure. Label the landform or the '
      + 'section; show a process such as erosion or the water cycle as the sequence it is. Where '
      + 'there is data, chart it and have the class describe the pattern before you explain it.',
  },
  {
    id: 'languages', name: 'Languages',
    match: /\b(english|language|literature|french|spanish|chinese|nyanja|bemba|tonga|literacy)\b/i,
    prefer: ['definition', 'scenario', 'discuss', 'image', 'sort', 'question', 'compare'],
    diagrams: ['grid', 'venn', 'tree', 'flow'],
    avoid: ['code'],
    note: 'A language is taught by using it. Give vocabulary with a picture and a sentence it '
      + 'lives in, not a translation list. A dialogue or a situation the class has to speak in is '
      + 'worth more than a grammar rule stated. Where a rule is needed, show two examples and have '
      + 'them sort a third.',
  },
  {
    id: 'arts', name: 'Arts and Design',
    match: /\b(art|music|drama|design|technolog|dance|creative)\b/i,
    prefer: ['image', 'compare', 'steps', 'task', 'discuss', 'statement'],
    diagrams: ['flow', 'grid', 'labelled', 'cycle'],
    avoid: ['code'],
    note: 'The arts are taught by looking at a piece and then making one. Show the work, ask what '
      + 'they notice, then demonstrate the technique as steps they can follow. The task is most of '
      + 'the lesson, so the slides before it should be short.',
  },
  {
    id: 'humanities', name: 'Humanities and Social Sciences',
    match: /\b(business|econom|account|commerce|religio|social|psycholog|sociolog)\b/i,
    prefer: ['scenario', 'compare', 'chart', 'table', 'discuss', 'question', 'diagram'],
    diagrams: ['flow', 'venn', 'tree', 'grid', 'timeline'],
    avoid: ['code'],
    note: 'These subjects are taught from a case. Give the class a real situation with the figures '
      + 'in it and have them decide something. Compare two positions side by side. Where there is '
      + 'a model or a chain of consequences, draw it.',
  },
  {
    id: 'default', name: 'General',
    match: /.*/,
    prefer: ['statement', 'diagram', 'bullets', 'question', 'task', 'compare'],
    diagrams: ['flow', 'cycle', 'grid', 'labelled', 'venn', 'timeline'],
    avoid: ['code'],
    note: 'Teach one idea per slide, show it as a picture where a picture explains it better than '
      + 'words, and have the class do something with it before moving on.',
  },
];

export const DEFAULT_PROFILE = SUBJECT_PROFILES[SUBJECT_PROFILES.length - 1];

export function profileFor(
  subjectId: string | null | undefined, subjectName?: string | null,
): SubjectProfile {
  const id = String(subjectId ?? '').trim();
  const name = String(subjectName ?? '').trim();
  if (id) {
    const byId = SUBJECT_PROFILES.find(p => p.id !== 'default' && p.match.test(id));
    if (byId) return byId;
  }
  if (name) {
    const byName = SUBJECT_PROFILES.find(p => p.id !== 'default' && p.match.test(name));
    if (byName) return byName;
  }
  return DEFAULT_PROFILE;
}

export function profileById(id: string | null | undefined): SubjectProfile {
  return SUBJECT_PROFILES.find(p => p.id === id) ?? DEFAULT_PROFILE;
}

/** The profile as the lines that go into the cached prompt prefix. */
export function profileBlock(p: SubjectProfile): string {
  return [
    'SUBJECT - ' + p.name,
    p.note,
    'Reach for these block types first, in this order: ' + p.prefer.join(', ') + '.',
    'Diagram kinds available for this subject: ' + p.diagrams.join(', ') + '.',
  ].join('\n');
}
