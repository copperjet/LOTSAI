-- Study pack v2 — block-composed packs, and packs built from a teacher's own file.
--
-- v1 stored one shape in `content`: units -> topics -> {key ideas, quiz, think}.
-- The school's own packs are not one shape. "CP5 Mathematic StudyPack 1.pdf" is a
-- 16:9 deck of key notes, worked examples and drill questions; "GP LS3 Study Pack
-- Formative 4.pdf" is an A4 landscape document of source cards, tables, a chart and
-- marked questions with answer space. v2 stores a vocabulary of blocks instead and
-- lets the model compose the pages.
--
-- The old content is not migrated. `content_version` says which shape a row holds,
-- and lib/studypack_render.ts branches on it, so a pack approved before this change
-- still opens exactly as it did. Nothing here is destructive.
alter table study_pack
  -- 1 = units/topics (the original shape), 2 = pages of blocks
  add column if not exists content_version smallint not null default 1,
  -- the print master's page size: 'a4-landscape' or 'slide-16x9'
  add column if not exists layout text not null default 'a4-landscape',
  -- 'registry' = built from signed-off curriculum weeks
  -- 'document' = built from an uploaded file, whose objectives may not all carry codes
  add column if not exists source_kind text not null default 'registry',
  -- per-objective provenance for this pack: [{ref, text, source, score}]
  -- source is 'registry' | 'matched' | 'file' — never 'model'. See
  -- lib/studypack/objectives.ts, and migration 0005 for the same idea on the registry.
  add column if not exists objective_sources jsonb not null default '[]';

alter table study_pack
  drop constraint if exists study_pack_source_kind_check;
alter table study_pack
  add constraint study_pack_source_kind_check check (source_kind in ('registry', 'document'));

-- A pack built from a file carries objectives the registry does not hold, so it must
-- be findable when a head asks what has been shared on that basis.
create index if not exists study_pack_source_kind on study_pack (source_kind)
  where source_kind = 'document';
