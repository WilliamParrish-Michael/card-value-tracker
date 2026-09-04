-- ============================================================
-- Card Value Tracker — Postgres schema (v2)
-- Scope: Pokemon (EN + JP), Magic: The Gathering, One Piece
--
-- What changed from v1:
--   - Sports dropped. Fuzzy matching demoted to a fallback.
--   - Identity is now deterministic. Every variant carries a
--     JustTCG UUID and a TCGplayer SKU ID, both unique. Any
--     other TCGplayer-derived source joins on the SKU with no
--     string matching at all.
--   - Grading kept but slim (JustTCG v2 exposes PSA/BGS/CGC as
--     first-class variants). Pop reports and grading-ROI tables
--     from v1 are gone — pull them back if you add sports.
--
-- Money is INTEGER CENTS throughout. JustTCG returns USD as a
-- float, so convert once at the adapter boundary and never let
-- a float past it.
-- ============================================================

CREATE TYPE product_kind AS ENUM ('single', 'sealed');
CREATE TYPE grader       AS ENUM ('PSA', 'BGS', 'CGC');
CREATE TYPE trade_currency AS ENUM ('cash', 'credit');

-- ------------------------------------------------------------
CREATE TABLE categories (
  id          SERIAL PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  -- The game slug JustTCG uses, so the sync job needs no mapping table.
  justtcg_game TEXT UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO categories (slug, name, justtcg_game) VALUES
  ('pokemon',       'Pokemon',                 'pokemon'),
  ('pokemon-jp',    'Pokemon Japan',           'pokemon-japan'),
  ('mtg',           'Magic: The Gathering',    'magic-the-gathering'),
  ('one-piece',     'One Piece Card Game',     'one-piece-card-game');

CREATE TABLE sets (
  id            SERIAL PRIMARY KEY,
  category_id   INTEGER NOT NULL REFERENCES categories(id),
  set_code      TEXT NOT NULL,               -- 'OP09', 'SV08', 'BLB'
  slug          TEXT NOT NULL,
  name          TEXT NOT NULL,
  released_on   DATE,
  UNIQUE (category_id, set_code),
  UNIQUE (category_id, slug)
);

-- ------------------------------------------------------------
-- Products. All three games publish a set code plus a collector
-- number, so this has a real natural key — the thing sports
-- didn't have.
-- ------------------------------------------------------------
CREATE TABLE products (
  id                BIGSERIAL PRIMARY KEY,
  category_id       INTEGER NOT NULL REFERENCES categories(id),
  set_id            INTEGER NOT NULL REFERENCES sets(id),
  kind              product_kind NOT NULL DEFAULT 'single',

  collector_number  TEXT NOT NULL,           -- 'OP09-093', '125/197', '042'
  name              TEXT NOT NULL,
  name_slug         TEXT NOT NULL,           -- normalized, for dedupe
  rarity            TEXT,
  image_url         TEXT,
  upc               TEXT,                    -- sealed only; manual until scanned

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Rarity is in the key because alt-art and secret-rare printings
  -- of the same collector number are separate market items — that
  -- gap is most of the value in One Piece.
  UNIQUE (set_id, collector_number, name_slug, rarity)
);

CREATE INDEX products_search_idx
  ON products USING gin (to_tsvector('english', name));

-- ------------------------------------------------------------
-- Variants: condition x printing x language, plus optional grade.
--
-- The two unique external IDs are what make this project cheap:
--   justtcg_uuid    - content-addressed, never changes. Primary sync key.
--   tcgplayer_sku_id- universal crosswalk. Every TCGplayer-derived
--                     source speaks this, so adding a second source
--                     is a join, not a matching problem.
-- ------------------------------------------------------------
CREATE TABLE variants (
  id                BIGSERIAL PRIMARY KEY,
  product_id        BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,

  condition         TEXT,        -- 'Near Mint','Lightly Played',...,'Sealed'
  printing          TEXT,        -- 'Normal','Foil','1st Edition','Holofoil'
  language          TEXT NOT NULL DEFAULT 'English',

  grader            grader,      -- NULL = ungraded (the common case)
  grade             NUMERIC(3,1),

  justtcg_uuid      UUID UNIQUE,
  justtcg_slug      TEXT,        -- legacy, human-readable, for debugging
  tcgplayer_sku_id  TEXT UNIQUE,

  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at    TIMESTAMPTZ,

  CONSTRAINT graded_has_grade
    CHECK ((grader IS NULL) = (grade IS NULL))
);

CREATE UNIQUE INDEX variants_natural_key
  ON variants (product_id, condition, printing, language, grader, grade)
  NULLS NOT DISTINCT;

CREATE INDEX variants_stale_idx ON variants (last_synced_at NULLS FIRST);

-- ------------------------------------------------------------
CREATE TABLE sources (
  key            TEXT PRIMARY KEY,
  display_name   TEXT NOT NULL,
  blend_weight   NUMERIC(4,2) NOT NULL DEFAULT 1.0,
  is_enabled     BOOLEAN NOT NULL DEFAULT true,
  -- Set true only on a plan whose terms permit it. Gate any public
  -- surface on this column rather than remembering which key it was.
  commercial_ok  BOOLEAN NOT NULL DEFAULT false
);

INSERT INTO sources (key, display_name, blend_weight) VALUES
  ('justtcg', 'JustTCG', 1.5),      -- blends listings with in-store sales
  ('tcgapi',  'TCG API', 1.0);

-- Fallback mapping, only for sources that expose neither a JustTCG
-- UUID nor a TCGplayer SKU. Most of your sources won't need a row here.
CREATE TABLE source_variants (
  source_key       TEXT NOT NULL REFERENCES sources(key),
  variant_id       BIGINT NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  external_id      TEXT NOT NULL,
  external_label   TEXT,
  match_confidence NUMERIC(3,2) NOT NULL DEFAULT 1.00,
  is_confirmed     BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (source_key, variant_id),
  UNIQUE (source_key, external_id)
);

-- ------------------------------------------------------------
-- Price observations — append-only.
--
-- Still worth keeping even though JustTCG now hands you history:
-- their window is bounded (7d/30d/90d/1y plus all-time extremes)
-- and it's their blend, not yours. This table is your own
-- multi-source series at your own cadence.
-- ------------------------------------------------------------
CREATE TABLE price_observations (
  id            BIGSERIAL PRIMARY KEY,
  variant_id    BIGINT NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  source_key    TEXT NOT NULL REFERENCES sources(key),
  observed_on   DATE NOT NULL,

  price_cents   INTEGER NOT NULL,
  avg_7d_cents  INTEGER,
  min_30d_cents INTEGER,
  max_30d_cents INTEGER,

  -- Dispersion straight from the source. High cov = thin or noisy
  -- market; feed it into confidence rather than discarding it.
  cov_7d        NUMERIC(8,4),
  trend_slope_30d NUMERIC(12,6),
  price_changes_30d INTEGER,

  -- True for rows backfilled from a source's own priceHistory
  -- array rather than observed live by your job.
  is_backfill   BOOLEAN NOT NULL DEFAULT false,
  raw_payload   JSONB,

  UNIQUE (variant_id, source_key, observed_on)
);

CREATE INDEX price_obs_variant_time_idx
  ON price_observations (variant_id, observed_on DESC);

-- ------------------------------------------------------------
CREATE TABLE daily_valuations (
  variant_id     BIGINT NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  valued_on      DATE NOT NULL,

  market_cents   INTEGER NOT NULL,
  source_count   SMALLINT NOT NULL,
  spread_pct     NUMERIC(6,2),
  confidence     NUMERIC(3,2),

  change_7d_pct  NUMERIC(7,2),
  change_30d_pct NUMERIC(7,2),
  change_90d_pct NUMERIC(7,2),
  -- 0..1 position inside the 90-day range. Near 0 on a stable card
  -- is your buy signal; near 1 is your sell signal.
  pos_in_90d_range NUMERIC(4,3),

  computed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (variant_id, valued_on)
);

CREATE INDEX daily_val_movers_idx
  ON daily_valuations (valued_on, change_7d_pct DESC);

-- ------------------------------------------------------------
-- Trade rules. Unchanged in shape from v1 — this part was never
-- about which game you cover.
-- ------------------------------------------------------------
CREATE TABLE trade_rules (
  id              SERIAL PRIMARY KEY,
  category_id     INTEGER REFERENCES categories(id),  -- NULL = all games
  kind            product_kind,                       -- NULL = both
  currency        trade_currency NOT NULL,

  min_cents       INTEGER NOT NULL DEFAULT 0,
  max_cents       INTEGER,
  rate_pct        NUMERIC(5,2) NOT NULL,
  floor_cents     INTEGER NOT NULL DEFAULT 0,
  ceiling_cents   INTEGER,

  -- Shade the rate down when the source reports a thin market.
  max_cov_7d              NUMERIC(8,4),
  volatility_penalty_pct  NUMERIC(5,2) NOT NULL DEFAULT 0,

  effective_from  DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to    DATE,
  notes           TEXT
);

CREATE INDEX trade_rules_lookup_idx
  ON trade_rules (currency, category_id, min_cents, max_cents)
  WHERE effective_to IS NULL;

INSERT INTO trade_rules (currency, min_cents, max_cents, rate_pct, notes) VALUES
  ('cash',      0,    200, 20.00, 'bulk'),
  ('cash',    200,   2000, 40.00, 'low-mid'),
  ('cash',   2000,  10000, 55.00, 'standard'),
  ('cash',  10000,   NULL, 65.00, 'hits'),
  ('credit',    0,    200, 30.00, NULL),
  ('credit',  200,   2000, 55.00, NULL),
  ('credit', 2000,  10000, 72.00, NULL),
  ('credit',10000,   NULL, 80.00, NULL);

-- ------------------------------------------------------------
-- Views
-- ------------------------------------------------------------
CREATE VIEW market_movers AS
SELECT
  c.slug          AS game,
  s.set_code,
  p.collector_number,
  p.name,
  p.rarity,
  v.printing,
  v.condition,
  dv.market_cents,
  dv.change_7d_pct,
  dv.change_30d_pct,
  dv.pos_in_90d_range,
  dv.confidence
FROM daily_valuations dv
JOIN variants   v ON v.id = dv.variant_id
JOIN products   p ON p.id = v.product_id
JOIN sets       s ON s.id = p.set_id
JOIN categories c ON c.id = p.category_id
WHERE dv.valued_on = CURRENT_DATE
  AND dv.confidence >= 0.5;

-- Percent premium of a foil/alt printing over the base printing of
-- the same card. In One Piece this spread is the market.
CREATE VIEW printing_premium AS
SELECT
  p.id AS product_id,
  p.name,
  s.set_code,
  p.collector_number,
  base.market_cents  AS base_cents,
  alt_v.printing     AS alt_printing,
  alt.market_cents   AS alt_cents,
  ROUND((alt.market_cents::NUMERIC / NULLIF(base.market_cents, 0) - 1) * 100, 2)
                     AS premium_pct
FROM products p
JOIN sets s ON s.id = p.set_id
JOIN variants base_v ON base_v.product_id = p.id
                    AND base_v.printing = 'Normal'
                    AND base_v.condition = 'Near Mint'
JOIN daily_valuations base ON base.variant_id = base_v.id
                          AND base.valued_on = CURRENT_DATE
JOIN variants alt_v ON alt_v.product_id = p.id
                   AND alt_v.printing <> 'Normal'
                   AND alt_v.condition = 'Near Mint'
JOIN daily_valuations alt ON alt.variant_id = alt_v.id
                         AND alt.valued_on = CURRENT_DATE;
