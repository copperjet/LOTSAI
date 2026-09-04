/**
 * How a study pack looks.
 *
 * Every pack used to be one design: forest and gold, Fraunces over Public Sans, a
 * dark panel cover, a gradient header band, and five accent colours dealt out in a
 * fixed order. Two packs for the same class were indistinguishable at a glance, and
 * a teacher with a term of them on a desk could not tell one from another - which is
 * the opposite of what the accent was for.
 *
 * The school's own packs are the evidence that this is a design choice rather than a
 * fixed template. "CP5 Mathematic StudyPack 1.pdf" is forest and gold with a serif
 * display, full-bleed section dividers and cream worked-example boxes; "CP5
 * Mathematic StudyPack 2.pdf" is navy, teal and amber with a sans display, card grids
 * on coloured left bars and dark answer bars. Same school, same subject, same year -
 * two documents that look nothing alike and are both plainly ours.
 *
 * So a theme carries everything that is not structure: the palette, the type, the
 * cover composition, the header treatment, the card treatment, the corner radius.
 * The page vocabulary (lib/studypack/schema.ts) does not change, and neither does
 * anything the model is asked for - `Accent` stays the five names it has always been,
 * and a theme decides what those five names look like.
 *
 * What a theme may never change: the crest, the school name, the footer credit and
 * dark text on a light body. Those are the Build Kit's non-negotiables and they hold
 * across all eight.
 */

/** One accent, as the header band and the card rules use it: a solid and its partner. */
export interface Slot { c1: string; c2: string }

export interface Theme {
  id: string;
  name: string;
  /** Font stacks. The families are loaded per theme, so a pack fetches only its own. */
  display: string;
  body: string;
  /** Google Fonts families this theme needs, for the stylesheet query. */
  families: string[];
  /** The five accent slots, in the order `ACCENTS` names them. */
  slots: [Slot, Slot, Slot, Slot, Slot];
  /**
   * The secondary highlight: objective codes, marks, the cover rule. Gold, in the
   * original. It is never one of the accents, so it reads on every page of the pack.
   */
  mark: string;
  /**
   * Neutrals. Hardcoded greens ran through the old stylesheet - a tinted note card
   * under a plum theme looked like a mistake, so the tints belong to the theme too.
   */
  ink: {
    text: string; paper: string; card: string; muted: string; line: string;
    tint: string;   // note cards, the objective strip, key ideas
    tint2: string;  // resource and worked-example boxes, table stripes
    deck: string;   // the screen background behind the sheets
    rule: string;   // ruled answer lines
    link: string;
  };
  /** The cover composition. */
  cover: 'panel' | 'orbit' | 'band' | 'split' | 'rule';
  /** The page header band. */
  head: 'gradient' | 'solid' | 'rule' | 'underline';
  /** How a note or resource card is drawn. */
  card: 'leftbar' | 'outline' | 'tint' | 'shadow';
  radius: number;
}

const FRAUNCES = "'Fraunces',Georgia,'Times New Roman',serif";
const SOURCE_SERIF = "'Source Serif 4',Georgia,'Times New Roman',serif";
const SPACE = "'Space Grotesk','Segoe UI',Arial,sans-serif";
const INTER = "'Inter','Segoe UI',Arial,sans-serif";
const PUBLIC = "'Public Sans','Segoe UI',Arial,sans-serif";
const KARLA = "'Karla','Segoe UI',Arial,sans-serif";

export const THEMES: Theme[] = [
  {
    id: 'oaktree-forest', name: 'Oaktree Forest',
    display: FRAUNCES, body: PUBLIC, families: ['Fraunces', 'Public Sans'],
    slots: [
      { c1: '#1D5829', c2: '#31773F' },
      { c1: '#4D27A5', c2: '#9F67FF' },
      { c1: '#0D9488', c2: '#22D3EE' },
      { c1: '#194AB3', c2: '#7C3AED' },
      { c1: '#B8860B', c2: '#E3A73B' },
    ],
    mark: '#B8860B',
    ink: {
      text: '#26302A', paper: '#FFFDF8', card: '#FFFFFF', muted: '#657064',
      line: '#D9DED2', tint: '#F5F7F0', tint2: '#FCFDFA', deck: '#EEF1E8',
      rule: '#B9C2B2', link: '#194AB3',
    },
    cover: 'panel', head: 'gradient', card: 'leftbar', radius: 8,
  },
  {
    id: 'navy-deck', name: 'Navy Deck',
    display: INTER, body: INTER, families: ['Inter'],
    slots: [
      { c1: '#1B2F5B', c2: '#33507F' },
      { c1: '#0F766E', c2: '#14B8A6' },
      { c1: '#B45309', c2: '#F59E0B' },
      { c1: '#3730A3', c2: '#6366F1' },
      { c1: '#334155', c2: '#64748B' },
    ],
    mark: '#B45309',
    ink: {
      text: '#172033', paper: '#FFFFFF', card: '#FFFFFF', muted: '#64748B',
      line: '#DDE3EC', tint: '#EEF2F8', tint2: '#F8FAFD', deck: '#E8EDF4',
      rule: '#AEBACB', link: '#1B2F5B',
    },
    cover: 'orbit', head: 'solid', card: 'shadow', radius: 4,
  },
  {
    id: 'slate-coral', name: 'Slate and Coral',
    display: SOURCE_SERIF, body: KARLA, families: ['Source Serif 4', 'Karla'],
    slots: [
      { c1: '#3F4C5A', c2: '#5D6E80' },
      { c1: '#C2410C', c2: '#F97316' },
      { c1: '#0E7490', c2: '#22D3EE' },
      { c1: '#6D28D9', c2: '#A78BFA' },
      { c1: '#92400E', c2: '#D97706' },
    ],
    mark: '#C2410C',
    ink: {
      text: '#232B33', paper: '#FFFCF9', card: '#FFFFFF', muted: '#6B7785',
      line: '#E2E0DA', tint: '#F6F3EE', tint2: '#FDFBF8', deck: '#EFEBE4',
      rule: '#C4BFB4', link: '#0E7490',
    },
    cover: 'split', head: 'rule', card: 'outline', radius: 6,
  },
  {
    id: 'plum-sand', name: 'Plum and Sand',
    display: FRAUNCES, body: PUBLIC, families: ['Fraunces', 'Public Sans'],
    slots: [
      { c1: '#5B2149', c2: '#8A3A72' },
      { c1: '#9D174D', c2: '#E11D48' },
      { c1: '#8A6D3B', c2: '#C79A4B' },
      { c1: '#3F6212', c2: '#65A30D' },
      { c1: '#1E3A8A', c2: '#3B82F6' },
    ],
    mark: '#8A6D3B',
    ink: {
      text: '#2A1F28', paper: '#FFFCFB', card: '#FFFFFF', muted: '#7A6B75',
      line: '#E7DEE3', tint: '#F8F1F5', tint2: '#FEFBFC', deck: '#F0E7EC',
      rule: '#C9B9C2', link: '#1E3A8A',
    },
    cover: 'band', head: 'solid', card: 'tint', radius: 10,
  },
  {
    id: 'ink-lime', name: 'Ink and Lime',
    display: SPACE, body: INTER, families: ['Space Grotesk', 'Inter'],
    slots: [
      { c1: '#1F2421', c2: '#3A423D' },
      { c1: '#4D7C0F', c2: '#84CC16' },
      { c1: '#0E7490', c2: '#06B6D4' },
      { c1: '#C2410C', c2: '#FB923C' },
      { c1: '#5B21B6', c2: '#8B5CF6' },
    ],
    mark: '#4D7C0F',
    ink: {
      text: '#1B1F1D', paper: '#FFFFFF', card: '#FFFFFF', muted: '#6B7280',
      line: '#E3E5E2', tint: '#F2F4F1', tint2: '#FAFBF9', deck: '#E9ECE8',
      rule: '#BCC1BB', link: '#0E7490',
    },
    cover: 'rule', head: 'underline', card: 'outline', radius: 2,
  },
  {
    id: 'terracotta', name: 'Terracotta',
    display: FRAUNCES, body: PUBLIC, families: ['Fraunces', 'Public Sans'],
    slots: [
      { c1: '#9A3412', c2: '#C2410C' },
      { c1: '#4D7C0F', c2: '#7CB518' },
      { c1: '#92400E', c2: '#D97706' },
      { c1: '#115E59', c2: '#0D9488' },
      { c1: '#7C2D12', c2: '#B45309' },
    ],
    mark: '#D97706',
    ink: {
      text: '#2E241D', paper: '#FFFCF7', card: '#FFFFFF', muted: '#7C6A5C',
      line: '#E8DFD3', tint: '#F9F3EA', tint2: '#FEFCF8', deck: '#F1E9DC',
      rule: '#CDBFAC', link: '#115E59',
    },
    cover: 'panel', head: 'solid', card: 'tint', radius: 8,
  },
  {
    id: 'ocean', name: 'Ocean',
    display: INTER, body: PUBLIC, families: ['Inter', 'Public Sans'],
    slots: [
      { c1: '#0B4F55', c2: '#137C84' },
      { c1: '#0369A1', c2: '#38BDF8' },
      { c1: '#A16207', c2: '#EAB308' },
      { c1: '#BE123C', c2: '#FB7185' },
      { c1: '#14532D', c2: '#16A34A' },
    ],
    mark: '#A16207',
    ink: {
      text: '#14262A', paper: '#FDFEFF', card: '#FFFFFF', muted: '#5F7B80',
      line: '#D7E4E6', tint: '#EFF6F7', tint2: '#F9FDFD', deck: '#E4EEF0',
      rule: '#AFC5C8', link: '#0369A1',
    },
    cover: 'orbit', head: 'gradient', card: 'leftbar', radius: 12,
  },
  {
    id: 'berry', name: 'Berry',
    display: FRAUNCES, body: KARLA, families: ['Fraunces', 'Karla'],
    slots: [
      { c1: '#7F1D3F', c2: '#A83A5F' },
      { c1: '#BE185D', c2: '#F472B6' },
      { c1: '#A16207', c2: '#D9A441' },
      { c1: '#3730A3', c2: '#6366F1' },
      { c1: '#166534', c2: '#22A559' },
    ],
    mark: '#A16207',
    ink: {
      text: '#2B1A22', paper: '#FFFCFD', card: '#FFFFFF', muted: '#7E6670',
      line: '#EADDE3', tint: '#FAF2F5', tint2: '#FEFBFC', deck: '#F2E6EB',
      rule: '#CDB6C0', link: '#3730A3',
    },
    cover: 'split', head: 'rule', card: 'shadow', radius: 6,
  },
];

/** The theme a pack with no theme stored renders in - the one design that existed
 *  before this file, so nothing already in `study_pack.content` changes. */
export const DEFAULT_THEME = THEMES[0];

export function themeById(id: string | null | undefined): Theme {
  return THEMES.find(t => t.id === id) ?? DEFAULT_THEME;
}

/** Stable, order-independent string hash. Same input, same number, every process. */
export function hash(s: string): number {
  let n = 0;
  for (const ch of s.toUpperCase()) n = (n * 31 + ch.charCodeAt(0)) % 9973;
  return n;
}

/**
 * How many themes a subject may wear.
 *
 * Two packs for the same class should look related and not identical, and two packs
 * for different subjects should be obviously different documents. A window rather
 * than a free choice is what gives both: the subject picks where the window starts,
 * the pack picks a place in it.
 */
const FAMILY = 3;

/**
 * The theme this pack wears.
 *
 * `subjectId` fixes the family, so a teacher's Mathematics packs keep a look; `seed`
 * - the pack's own work key - moves within it, so the next one is not the last one.
 * Both are stable, so a pack re-rendered a term later is the pack they remember.
 */
export function pickTheme(subjectId: string, seed: string): Theme {
  const home = hash(subjectId) % THEMES.length;
  const within = hash(seed) % FAMILY;
  return THEMES[(home + within) % THEMES.length];
}

/** The Google Fonts stylesheet a theme needs. */
export function fontHref(theme: Theme): string {
  const q = theme.families.map(f => {
    const name = f.replace(/ /g, '+');
    // Fraunces is the one variable face here that needs its optical-size axis named.
    return f === 'Fraunces'
      ? `family=${name}:opsz,wght@9..144,600;9..144,700`
      : `family=${name}:wght@400;500;600;700`;
  }).join('&');
  return `https://fonts.googleapis.com/css2?${q}&display=swap`;
}
