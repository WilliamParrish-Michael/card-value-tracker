'use strict';

/**
 * Feature addendum — sealed product, sourcing friction, trade balancer.
 * Purely additive: no existing table is rewritten, no data is touched.
 *
 * products.upc already exists (initial schema), so it's added defensively with
 * IF NOT EXISTS; pricecharting_id and ebay_epid are new. A 'pricecharting'
 * source row is added (sealed source); JustTCG stays the singles source.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE products ADD COLUMN IF NOT EXISTS upc              TEXT;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS pricecharting_id TEXT;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS ebay_epid        TEXT;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS tcgplayer_id     TEXT;

      CREATE UNIQUE INDEX IF NOT EXISTS products_upc_idx ON products (upc) WHERE upc IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS products_pc_idx  ON products (pricecharting_id) WHERE pricecharting_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS sealed_config (
        product_id      BIGINT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
        format          TEXT NOT NULL,
        packs_included  INTEGER,
        cards_per_pack  INTEGER,
        msrp_cents      INTEGER,
        released_on     DATE
      );

      CREATE TABLE IF NOT EXISTS sourcing_friction (
        product_id        BIGINT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
        manual_score      SMALLINT CHECK (manual_score BETWEEN 0 AND 100),
        purchase_limit    SMALLINT,
        is_allocated      BOOLEAN NOT NULL DEFAULT false,
        notes             TEXT,
        auto_score        SMALLINT CHECK (auto_score BETWEEN 0 AND 100),
        auto_inputs       JSONB,
        auto_computed_at  TIMESTAMPTZ,
        premium_pct       NUMERIC(5,2) NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS trade_sessions (
        id            BIGSERIAL PRIMARY KEY,
        label         TEXT,
        valued_on     DATE NOT NULL DEFAULT CURRENT_DATE,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        result_json   JSONB
      );

      CREATE TABLE IF NOT EXISTS trade_lines (
        id            BIGSERIAL PRIMARY KEY,
        session_id    BIGINT NOT NULL REFERENCES trade_sessions(id) ON DELETE CASCADE,
        side          SMALLINT NOT NULL CHECK (side IN (1, 2)),
        variant_id    BIGINT NOT NULL REFERENCES variants(id),
        quantity      INTEGER NOT NULL CHECK (quantity > 0),
        unit_cents    INTEGER NOT NULL,
        friction_pct  NUMERIC(5,2) NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS trade_lines_session_idx ON trade_lines (session_id);

      -- Sealed source. blend_weight is moot for sealed (single source), but the
      -- row must exist for the price_observations FK and the commercial gate.
      INSERT INTO sources (key, display_name, blend_weight, commercial_ok)
        VALUES ('pricecharting', 'PriceCharting', 1.0, false)
        ON CONFLICT (key) DO NOTHING;
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DELETE FROM sources WHERE key = 'pricecharting';
      DROP TABLE IF EXISTS trade_lines;
      DROP TABLE IF EXISTS trade_sessions;
      DROP TABLE IF EXISTS sourcing_friction;
      DROP TABLE IF EXISTS sealed_config;
      DROP INDEX IF EXISTS products_pc_idx;
      DROP INDEX IF EXISTS products_upc_idx;
      ALTER TABLE products DROP COLUMN IF EXISTS ebay_epid;
      ALTER TABLE products DROP COLUMN IF EXISTS pricecharting_id;
      -- upc + tcgplayer_id left in place (upc predates this migration).
    `);
  },
};
