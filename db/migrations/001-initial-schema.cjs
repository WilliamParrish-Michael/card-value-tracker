'use strict';

/**
 * Initial schema — executes db/schema.sql verbatim so the ORM never drifts from
 * the authoritative DDL. The SQL uses Postgres 15+ features (NULLS NOT DISTINCT,
 * partial indexes, views); keeping it as one file preserves those exactly.
 */
const fs = require('node:fs');
const path = require('node:path');

const schemaPath = path.resolve(__dirname, '..', 'schema.sql');

module.exports = {
  async up(queryInterface) {
    const sql = fs.readFileSync(schemaPath, 'utf8');
    await queryInterface.sequelize.query(sql);
  },

  async down(queryInterface) {
    // Reverse of schema.sql. Drop views, then tables, then the enum types.
    await queryInterface.sequelize.query(`
      DROP VIEW IF EXISTS printing_premium;
      DROP VIEW IF EXISTS market_movers;
      DROP TABLE IF EXISTS trade_rules;
      DROP TABLE IF EXISTS daily_valuations;
      DROP TABLE IF EXISTS price_observations;
      DROP TABLE IF EXISTS source_variants;
      DROP TABLE IF EXISTS sources;
      DROP TABLE IF EXISTS variants;
      DROP TABLE IF EXISTS products;
      DROP TABLE IF EXISTS sets;
      DROP TABLE IF EXISTS categories;
      DROP TYPE IF EXISTS trade_currency;
      DROP TYPE IF EXISTS grader;
      DROP TYPE IF EXISTS product_kind;
    `);
  },
};
