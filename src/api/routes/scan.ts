/**
 * Milestone 4 — scan resolution (the server half; the camera lives in the web app).
 *
 * The chain: cert number -> PSA lookup -> match OUR product -> variant -> value.
 * Step "match" is the hard one and is never silent:
 *   - a confirmed cert resolves instantly from source_variants
 *   - PSA-not-recognized returns a clear error and STOPS (no name-based guess)
 *   - a low-confidence match returns candidates for the operator to pick
 *   - only a confident, unique match is treated as resolved
 *
 * BGS/CGC have no cert API — those are manual entry, said plainly by the client.
 * Sealed UPCs route to products.kind = 'sealed'.
 */
import { Router } from 'express';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../models/index.js';
import { buildPsa, PsaCertNotFound, PsaError, isValidCertNumber, type PsaCert } from '../../sources/psa.js';

const CONFIDENCE_THRESHOLD = 0.8;

const parseGrade = (g?: string): number | null => {
  const m = g?.match(/(\d+(?:\.\d)?)/);
  return m ? Number(m[1]) : null;
};

interface Candidate {
  product_id: string; game: string; set_code: string; collector_number: string;
  name: string; rarity: string | null; score: number;
}

async function matchCandidates(psa: PsaCert): Promise<Candidate[]> {
  const subject = psa.subject ?? '';
  const cardNumber = psa.cardNumber ?? '';
  if (!subject && !cardNumber) return [];

  const rows = await sequelize.query<Omit<Candidate, 'score'>>(
    `SELECT p.id::text AS product_id, c.slug AS game, s.set_code,
            p.collector_number, p.name, p.rarity
       FROM products p
       JOIN sets s ON s.id = p.set_id
       JOIN categories c ON c.id = p.category_id
      WHERE ($num <> '' AND p.collector_number ILIKE '%' || $num || '%')
         OR ($subj <> '' AND to_tsvector('english', p.name) @@ plainto_tsquery('english', $subj))
      LIMIT 25`,
    { bind: { num: cardNumber, subj: subject }, type: QueryTypes.SELECT },
  );

  const subjTokens = new Set(subject.toLowerCase().split(/\s+/).filter(Boolean));
  return rows
    .map((row) => {
      let score = 0;
      // Card-number agreement is the strongest deterministic signal.
      if (cardNumber && row.collector_number.toLowerCase().includes(cardNumber.toLowerCase())) score += 0.6;
      // Name/subject token overlap.
      const nameTokens = row.name.toLowerCase().split(/\s+/).filter(Boolean);
      const overlap = nameTokens.filter((t) => subjTokens.has(t)).length;
      if (subjTokens.size) score += 0.4 * (overlap / subjTokens.size);
      return { ...row, score: Math.round(Math.min(1, score) * 100) / 100 };
    })
    .sort((a, b) => b.score - a.score);
}

export function scanRouter(): Router {
  const r = Router();

  // Cert lookup + match.
  r.post('/cert', async (req, res) => {
    const cert = String(req.body?.cert ?? '').trim();
    if (!isValidCertNumber(cert)) {
      return res.status(400).json({ error: 'A PSA cert number is 8–10 digits.', reason: 'invalid_format' });
    }

    try {
      // Fast path: a previously confirmed cert resolves instantly.
      const [confirmed] = await sequelize.query<{ variant_id: string }>(
        `SELECT variant_id::text FROM source_variants
          WHERE source_key = 'psa' AND external_id = $cert AND is_confirmed = true LIMIT 1`,
        { bind: { cert }, type: QueryTypes.SELECT },
      );
      if (confirmed) {
        const [variant] = await sequelize.query(
          `SELECT v.id::text, v.grader, v.grade::text, p.name, p.collector_number, c.slug AS game, s.set_code,
                  dv.market_cents, dv.confidence::text
             FROM variants v JOIN products p ON p.id = v.product_id
             JOIN categories c ON c.id = p.category_id JOIN sets s ON s.id = p.set_id
             LEFT JOIN LATERAL (SELECT market_cents, confidence FROM daily_valuations dv
                                WHERE dv.variant_id = v.id ORDER BY valued_on DESC LIMIT 1) dv ON true
            WHERE v.id = $id`,
          { bind: { id: confirmed.variant_id }, type: QueryTypes.SELECT },
        );
        return res.json({ data: { resolved: true, variant, candidates: [] } });
      }

      // Live PSA lookup.
      const psa = buildPsa();
      let cert_data: PsaCert;
      try {
        cert_data = await psa.lookupCert(cert);
      } catch (err) {
        if (err instanceof PsaCertNotFound) {
          return res.status(404).json({ error: err.detail, reason: 'cert_not_found' });
        }
        if (err instanceof PsaError) {
          // 403 not approved, 503 not configured — name it, don't guess.
          return res.status(err.status === 403 ? 403 : 502).json({ error: err.detail, reason: 'psa_unavailable' });
        }
        throw err;
      }

      const candidates = await matchCandidates(cert_data);
      const top = candidates[0];
      const confident = top && top.score >= CONFIDENCE_THRESHOLD && (candidates.length === 1 || top.score - (candidates[1]?.score ?? 0) >= 0.2);

      res.json({
        data: {
          resolved: false,
          cert: cert_data,
          grade: parseGrade(cert_data.grade),
          // Only a confident, clearly-separated match is proposed; otherwise the
          // client shows the picker and prices nothing automatically.
          match: confident ? top : null,
          candidates,
          threshold: CONFIDENCE_THRESHOLD,
        },
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Confirm a cert -> product choice: find/create the graded variant and remember it.
  r.post('/confirm', async (req, res) => {
    const cert = String(req.body?.cert ?? '').trim();
    const productId = String(req.body?.product_id ?? '').trim();
    const grader = (req.body?.grader ?? 'PSA') as string;
    const grade = req.body?.grade == null ? null : Number(req.body.grade);
    if (!isValidCertNumber(cert) || !productId || grade == null) {
      return res.status(400).json({ error: 'cert (8–10 digits), product_id, and grade are required' });
    }

    try {
      // Find or create the graded variant for this product + grader + grade.
      const [existing] = await sequelize.query<{ id: string }>(
        `SELECT id::text FROM variants
          WHERE product_id = $pid AND grader = $grader AND grade = $grade LIMIT 1`,
        { bind: { pid: productId, grader, grade }, type: QueryTypes.SELECT },
      );
      let variantId = existing?.id;
      if (!variantId) {
        const [created] = await sequelize.query<{ id: string }>(
          `INSERT INTO variants (product_id, condition, printing, language, grader, grade)
           VALUES ($pid, NULL, 'Normal', 'English', $grader, $grade) RETURNING id::text`,
          { bind: { pid: productId, grader, grade }, type: QueryTypes.SELECT },
        );
        variantId = created.id;
      }

      await sequelize.query(
        `INSERT INTO source_variants (source_key, variant_id, external_id, external_label, match_confidence, is_confirmed)
         VALUES ('psa', $vid, $cert, $label, 1.00, true)
         ON CONFLICT (source_key, variant_id) DO UPDATE
           SET external_id = EXCLUDED.external_id, external_label = EXCLUDED.external_label, is_confirmed = true`,
        { bind: { vid: variantId, cert, label: `PSA ${grade} cert ${cert}` } },
      );

      res.json({ data: { variant_id: variantId } });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Sealed product by UPC (12–13 digits). No UPC in the JustTCG catalog, so this
  // starts empty and improves as the operator associates UPCs to sealed products.
  r.post('/upc', async (req, res) => {
    const upc = String(req.body?.upc ?? '').trim();
    if (!/^\d{12,13}$/.test(upc)) {
      return res.status(400).json({ error: 'A UPC is 12–13 digits.', reason: 'invalid_format' });
    }
    try {
      const matches = await sequelize.query(
        `SELECT p.id::text AS product_id, c.slug AS game, s.set_code, p.name
           FROM products p JOIN sets s ON s.id = p.set_id JOIN categories c ON c.id = p.category_id
          WHERE p.kind = 'sealed' AND p.upc = $upc`,
        { bind: { upc }, type: QueryTypes.SELECT },
      );
      res.json({ data: { matches, needsAssociation: matches.length === 0 } });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Associate a UPC with a sealed product (operator-driven; grows the mapping).
  r.post('/upc/associate', async (req, res) => {
    const upc = String(req.body?.upc ?? '').trim();
    const productId = String(req.body?.product_id ?? '').trim();
    if (!/^\d{12,13}$/.test(upc) || !productId) {
      return res.status(400).json({ error: 'upc (12–13 digits) and product_id are required' });
    }
    try {
      await sequelize.query(`UPDATE products SET upc = $upc WHERE id = $pid AND kind = 'sealed'`, { bind: { upc, pid: productId } });
      res.json({ data: { product_id: productId, upc } });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  return r;
}
