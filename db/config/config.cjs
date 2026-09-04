'use strict';

/**
 * sequelize-cli config. Reads DATABASE_URL from the environment for every
 * environment — one Postgres 15+ instance, no per-env credentials in the repo.
 */
require('dotenv/config');

const use_env_variable = 'DATABASE_URL';
const base = { use_env_variable, dialect: 'postgres', logging: false };

module.exports = { development: base, test: base, production: base };
