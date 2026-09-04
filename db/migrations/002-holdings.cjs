'use strict';

/**
 * Collection holdings (Milestone 3). The original schema.sql didn't include it;
 * the spec defines holdings(variant_id, quantity, acquired_cents, acquired_on,
 * notes). acquired_cents is what YOU paid — integer cents like everything else,
 * and it's what turns the collection view into a real P&L rather than a price list.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS holdings (
        id             BIGSERIAL PRIMARY KEY,
        variant_id     BIGINT NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
        quantity       INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
        acquired_cents INTEGER,            -- what you paid; NULL = unknown, never 0-as-unknown
        acquired_on    DATE,
        notes          TEXT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS holdings_variant_idx ON holdings (variant_id);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS holdings;');
  },
};
