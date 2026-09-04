/**
 * Sequelize connection + models.
 *
 * The authoritative schema is db/schema.sql (applied via the migration in
 * db/migrations). These models map onto those existing tables — they do not
 * own the DDL. Postgres-specific features the ORM can't express (NULLS NOT
 * DISTINCT unique indexes, partial indexes, views, ON CONFLICT upserts) live
 * in raw SQL in the jobs and routes; the models cover ordinary reads/writes.
 *
 * Enum columns are typed as STRING here so Sequelize never tries to (re)create
 * the Postgres ENUM types — schema.sql already did.
 *
 * Money is integer cents everywhere. BIGINT ids come back from pg as strings;
 * the app treats ids as strings and never does math on them.
 */
import 'dotenv/config';
import { Sequelize, DataTypes, type Model, type ModelStatic } from 'sequelize';

const url = process.env.DATABASE_URL;
if (!url) {
  // Fail loudly and early — a missing DB URL is a config error, not something
  // to paper over with a default that silently points at the wrong place.
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
}

// Managed Postgres (Neon, Render external) needs SSL; a Render internal URL does
// not (and forcing it fails). Gate on PGSSL so both work: unset = no SSL.
const useSsl = process.env.PGSSL === 'require' || process.env.PGSSL === 'true';

export const sequelize = new Sequelize(url, {
  dialect: 'postgres',
  logging: false,
  dialectOptions: useSsl ? { ssl: { require: true, rejectUnauthorized: false } } : {},
  define: { timestamps: false, freezeTableName: true },
});

const cents = () => ({ type: DataTypes.INTEGER });

export const Category = sequelize.define('categories', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  slug: DataTypes.TEXT,
  name: DataTypes.TEXT,
  justtcg_game: DataTypes.TEXT,
  created_at: DataTypes.DATE,
});

export const Set = sequelize.define('sets', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  category_id: DataTypes.INTEGER,
  set_code: DataTypes.TEXT,
  slug: DataTypes.TEXT,
  name: DataTypes.TEXT,
  released_on: DataTypes.DATEONLY,
});

export const Product = sequelize.define('products', {
  id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
  category_id: DataTypes.INTEGER,
  set_id: DataTypes.INTEGER,
  kind: DataTypes.STRING,          // product_kind enum
  collector_number: DataTypes.TEXT,
  name: DataTypes.TEXT,
  name_slug: DataTypes.TEXT,
  rarity: DataTypes.TEXT,
  image_url: DataTypes.TEXT,
  upc: DataTypes.TEXT,
  pricecharting_id: DataTypes.TEXT,
  ebay_epid: DataTypes.TEXT,
  tcgplayer_id: DataTypes.TEXT,
  created_at: DataTypes.DATE,
  updated_at: DataTypes.DATE,
});

export const Variant = sequelize.define('variants', {
  id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
  product_id: DataTypes.BIGINT,
  condition: DataTypes.TEXT,
  printing: DataTypes.TEXT,
  language: DataTypes.TEXT,
  grader: DataTypes.STRING,        // grader enum
  grade: DataTypes.DECIMAL(3, 1),
  justtcg_uuid: DataTypes.UUID,
  justtcg_slug: DataTypes.TEXT,
  tcgplayer_sku_id: DataTypes.TEXT,
  first_seen_at: DataTypes.DATE,
  last_synced_at: DataTypes.DATE,
});

export const Source = sequelize.define('sources', {
  key: { type: DataTypes.TEXT, primaryKey: true },
  display_name: DataTypes.TEXT,
  blend_weight: DataTypes.DECIMAL(4, 2),
  is_enabled: DataTypes.BOOLEAN,
  commercial_ok: DataTypes.BOOLEAN,
});

export const SourceVariant = sequelize.define('source_variants', {
  source_key: { type: DataTypes.TEXT, primaryKey: true },
  variant_id: { type: DataTypes.BIGINT, primaryKey: true },
  external_id: DataTypes.TEXT,
  external_label: DataTypes.TEXT,
  match_confidence: DataTypes.DECIMAL(3, 2),
  is_confirmed: DataTypes.BOOLEAN,
});

export const PriceObservation = sequelize.define('price_observations', {
  id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
  variant_id: DataTypes.BIGINT,
  source_key: DataTypes.TEXT,
  observed_on: DataTypes.DATEONLY,
  price_cents: cents(),
  avg_7d_cents: cents(),
  min_30d_cents: cents(),
  max_30d_cents: cents(),
  cov_7d: DataTypes.DECIMAL(8, 4),
  trend_slope_30d: DataTypes.DECIMAL(12, 6),
  price_changes_30d: DataTypes.INTEGER,
  is_backfill: DataTypes.BOOLEAN,
  raw_payload: DataTypes.JSONB,
});

export const DailyValuation = sequelize.define('daily_valuations', {
  variant_id: { type: DataTypes.BIGINT, primaryKey: true },
  valued_on: { type: DataTypes.DATEONLY, primaryKey: true },
  market_cents: cents(),
  source_count: DataTypes.SMALLINT,
  spread_pct: DataTypes.DECIMAL(6, 2),
  confidence: DataTypes.DECIMAL(3, 2),
  change_7d_pct: DataTypes.DECIMAL(7, 2),
  change_30d_pct: DataTypes.DECIMAL(7, 2),
  change_90d_pct: DataTypes.DECIMAL(7, 2),
  pos_in_90d_range: DataTypes.DECIMAL(4, 3),
  computed_at: DataTypes.DATE,
});

export const TradeRule = sequelize.define('trade_rules', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  category_id: DataTypes.INTEGER,
  kind: DataTypes.STRING,          // product_kind enum, nullable
  currency: DataTypes.STRING,      // trade_currency enum
  min_cents: cents(),
  max_cents: cents(),
  rate_pct: DataTypes.DECIMAL(5, 2),
  floor_cents: cents(),
  ceiling_cents: cents(),
  max_cov_7d: DataTypes.DECIMAL(8, 4),
  volatility_penalty_pct: DataTypes.DECIMAL(5, 2),
  effective_from: DataTypes.DATEONLY,
  effective_to: DataTypes.DATEONLY,
  notes: DataTypes.TEXT,
});

// Collection holdings (added by db/migrations/002 — not in the original schema.sql).
export const Holding = sequelize.define('holdings', {
  id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
  variant_id: DataTypes.BIGINT,
  quantity: DataTypes.INTEGER,
  acquired_cents: cents(),
  acquired_on: DataTypes.DATEONLY,
  notes: DataTypes.TEXT,
  created_at: DataTypes.DATE,
});

// --- Addendum: sealed product, sourcing friction, trades --------------------
export const SealedConfig = sequelize.define('sealed_config', {
  product_id: { type: DataTypes.BIGINT, primaryKey: true },
  format: DataTypes.TEXT,
  packs_included: DataTypes.INTEGER,
  cards_per_pack: DataTypes.INTEGER,
  msrp_cents: cents(),
  released_on: DataTypes.DATEONLY,
});

export const SourcingFriction = sequelize.define('sourcing_friction', {
  product_id: { type: DataTypes.BIGINT, primaryKey: true },
  manual_score: DataTypes.SMALLINT,
  purchase_limit: DataTypes.SMALLINT,
  is_allocated: DataTypes.BOOLEAN,
  notes: DataTypes.TEXT,
  auto_score: DataTypes.SMALLINT,
  auto_inputs: DataTypes.JSONB,
  auto_computed_at: DataTypes.DATE,
  premium_pct: DataTypes.DECIMAL(5, 2),
});

export const TradeSession = sequelize.define('trade_sessions', {
  id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
  label: DataTypes.TEXT,
  valued_on: DataTypes.DATEONLY,
  created_at: DataTypes.DATE,
  result_json: DataTypes.JSONB,
});

export const TradeLine = sequelize.define('trade_lines', {
  id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
  session_id: DataTypes.BIGINT,
  side: DataTypes.SMALLINT,
  variant_id: DataTypes.BIGINT,
  quantity: DataTypes.INTEGER,
  unit_cents: cents(),
  friction_pct: DataTypes.DECIMAL(5, 2),
});

// Associations (for eager reads in the API).
Set.belongsTo(Category, { foreignKey: 'category_id' });
Product.belongsTo(Category, { foreignKey: 'category_id' });
Product.belongsTo(Set, { foreignKey: 'set_id' });
Variant.belongsTo(Product, { foreignKey: 'product_id' });
Product.hasMany(Variant, { foreignKey: 'product_id' });
Holding.belongsTo(Variant, { foreignKey: 'variant_id' });

export type AnyModel = ModelStatic<Model>;
SealedConfig.belongsTo(Product, { foreignKey: 'product_id' });
SourcingFriction.belongsTo(Product, { foreignKey: 'product_id' });
TradeLine.belongsTo(TradeSession, { foreignKey: 'session_id' });
TradeLine.belongsTo(Variant, { foreignKey: 'variant_id' });

export const models = {
  Category, Set, Product, Variant, Source, SourceVariant,
  PriceObservation, DailyValuation, TradeRule, Holding,
  SealedConfig, SourcingFriction, TradeSession, TradeLine,
};
