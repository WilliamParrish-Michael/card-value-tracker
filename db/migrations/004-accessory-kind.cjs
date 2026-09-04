'use strict';

/**
 * Add 'accessory' to the product_kind enum so sleeves, pouches, code cards, etc.
 * can be classified separately from sealed product (and cards). Additive and
 * idempotent (IF NOT EXISTS). ADD VALUE runs fine outside a transaction on PG16.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TYPE product_kind ADD VALUE IF NOT EXISTS 'accessory'`,
    );
  },
  // Postgres cannot drop a single enum value; down is a no-op.
  async down() {},
};
