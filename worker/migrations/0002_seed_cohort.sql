-- Seed watchlist + shadow cohort.
--
-- The cohort list is an explicit open decision in the spec (section 12.4).
-- These are starting seeds for the baby-names / family / etymology niches;
-- `tt_system_status` reports cohort size so the gap against the 50-account
-- target stays visible, and `scripts/seed-cohort.mjs` appends more.

INSERT INTO watchlist (entity_type, entity_id, niche, added_at, active) VALUES
  ('hashtag', 'babynames', 'baby-names', unixepoch(), 1),
  ('hashtag', 'babyname', 'baby-names', unixepoch(), 1),
  ('hashtag', 'nameideas', 'baby-names', unixepoch(), 1),
  ('hashtag', 'namemeaning', 'baby-names', unixepoch(), 1),
  ('hashtag', 'uniquenames', 'baby-names', unixepoch(), 1),
  ('hashtag', 'vintagenames', 'baby-names', unixepoch(), 1),
  ('hashtag', 'girlnames', 'baby-names', unixepoch(), 1),
  ('hashtag', 'boynames', 'baby-names', unixepoch(), 1),
  ('hashtag', 'namesakes', 'etymology', unixepoch(), 1),
  ('hashtag', 'etymology', 'etymology', unixepoch(), 1),
  ('hashtag', 'familyhumor', 'parenting-humor', unixepoch(), 1),
  ('hashtag', 'parentinghumor', 'parenting-humor', unixepoch(), 1),
  ('hashtag', 'momsoftiktok', 'parenting-humor', unixepoch(), 1),
  ('hashtag', 'dadsoftiktok', 'parenting-humor', unixepoch(), 1),
  ('hashtag', 'newborn', 'parenting-humor', unixepoch(), 1),
  ('hashtag', 'pregnancy', 'parenting-humor', unixepoch(), 1),
  ('hashtag', 'datastorytelling', 'data-storytelling', unixepoch(), 1),
  ('hashtag', 'charts', 'data-storytelling', unixepoch(), 1),
  ('hashtag', 'ranking', 'data-storytelling', unixepoch(), 1),
  ('hashtag', 'tierlist', 'data-storytelling', unixepoch(), 1);

-- Cohort usernames are intentionally left empty here: seeding accounts
-- requires the curation pass called out in the spec. Use
-- `POST /admin/cohort` once the list is chosen, or run
-- `scripts/seed-cohort.mjs <file>`.
