/**
 * PSA cert lookup — the ONE thing the PSA public API does: cert number in,
 * card description + grade out. https://api.psacard.com/publicapi
 *
 * Verified against the live API + PSA's published docs (the spec's guesses were
 * off in two ways):
 *   - Base is api.psacard.com/publicapi (not www.psacard.com/publicapi).
 *   - Auth is a PRE-ISSUED bearer token you generate on the PSA site, sent as
 *     `authorization: bearer <token>` — NOT a username/password grant. So this
 *     takes PSA_ACCESS_TOKEN, not PSA_USERNAME/PASSWORD.
 *   - A 200 does NOT mean data: the body carries { IsValidRequest, ServerMessage }.
 *       false / "Invalid CertNo"     -> bad cert format
 *       true  / "No data found"      -> PSA has no such cert  -> PsaCertNotFound
 *       true  / "Request successful" -> real data alongside it
 *   - 403 "Access to this API is limited to approved customers" -> the account
 *     is not approved for API access yet (request it: collectors-apis@collectors.com).
 *
 * Explicitly NOT here (no public PSA endpoint exists): population reports,
 * price-guide/valuation data, grading submissions. A slab's price comes from
 * OUR daily_valuations after the cert is matched to a variant — never from PSA.
 */

export interface PsaCert {
  certNumber: string;
  year?: string;
  brand?: string;          // e.g. "POKEMON JAPANESE SV1a"
  subject?: string;        // e.g. "CHARIZARD EX"
  cardNumber?: string;     // PSA's card number, in PSA's vocabulary
  variety?: string;
  grade?: string;          // "GEM MT 10", "MINT 9", ...
  category?: string;
  /** Cert images exist only for cards graded from October 2021 onward. */
  imageUrl?: string | null;
  raw: unknown;
}

export class PsaError extends Error {
  constructor(readonly status: number, readonly detail: string) {
    super(`[psa] ${status}: ${detail}`);
  }
}

/** Thrown when PSA has no record of a cert (or the cert format is invalid). The
 *  caller MUST surface this and MUST NOT fall through to a name-based guess. */
export class PsaCertNotFound extends PsaError {
  constructor(readonly cert: string, detail = `cert ${cert} not recognized by PSA`) {
    super(404, detail);
  }
}

/** A slab cert is 8–10 digits. Validate before spending an API call. */
export function isValidCertNumber(cert: string): boolean {
  return /^\d{8,10}$/.test(cert.trim());
}

export interface PsaOptions {
  accessToken?: string;
  baseUrl?: string;
}

export class PsaSource {
  private readonly baseUrl: string;

  constructor(private readonly opts: PsaOptions = {}) {
    this.baseUrl = opts.baseUrl ?? 'https://api.psacard.com/publicapi';
  }

  get configured(): boolean {
    return Boolean(this.opts.accessToken);
  }

  /**
   * Look up a cert. Throws:
   *   - PsaError(503) if no token is configured
   *   - PsaError(403) if the account isn't approved for API access
   *   - PsaCertNotFound on invalid format or "No data found"
   * so the UI can say exactly what's wrong and stop — never guess a card.
   */
  async lookupCert(certNumber: string): Promise<PsaCert> {
    const cert = certNumber.trim();
    if (!this.opts.accessToken) {
      throw new PsaError(503, 'PSA not configured — set PSA_ACCESS_TOKEN (generate it on the PSA site)');
    }
    if (!isValidCertNumber(cert)) {
      throw new PsaCertNotFound(cert, `"${cert}" is not a valid 8–10 digit cert number`);
    }

    const res = await fetch(`${this.baseUrl}/cert/GetByCertNumber/${encodeURIComponent(cert)}`, {
      headers: { authorization: `bearer ${this.opts.accessToken}` },
    });

    if (res.status === 403) {
      throw new PsaError(403, 'PSA API access not approved for this account — request access at collectors-apis@collectors.com');
    }
    if (res.status === 204) throw new PsaError(204, 'PSA received an empty request (missing cert number)');
    if (res.status === 500) throw new PsaError(500, 'PSA rejected the credentials (500) — check PSA_ACCESS_TOKEN');
    if (!res.ok) throw new PsaError(res.status, await res.text().catch(() => ''));

    const body = (await res.json()) as {
      IsValidRequest?: boolean;
      ServerMessage?: string;
      PSACert?: Record<string, unknown>;
    } & Record<string, unknown>;

    // A 200 does not imply data — read the envelope flags first.
    if (body.IsValidRequest === false) {
      throw new PsaCertNotFound(cert, body.ServerMessage || 'Invalid CertNo');
    }
    if (/no data found/i.test(body.ServerMessage ?? '')) {
      throw new PsaCertNotFound(cert);
    }

    const c = (body.PSACert ?? body) as Record<string, unknown>;
    const str = (k: string) => (c[k] == null ? undefined : String(c[k]));

    // Defensive: if the "successful" body still has nothing identifying, treat it
    // as not-found rather than emitting a blank, matchable-looking record.
    if (!str('CertNumber') && !str('Subject') && !str('Year')) {
      throw new PsaCertNotFound(cert);
    }

    return {
      certNumber: str('CertNumber') ?? cert,
      year: str('Year'),
      brand: str('Brand'),
      subject: str('Subject'),
      cardNumber: str('CardNumber'),
      variety: str('Variety'),
      grade: str('CardGrade') ?? str('GradeDescription') ?? str('Grade'),
      category: str('Category'),
      imageUrl: str('ImageUrl') ?? null,
      raw: body,
    };
  }
}

/** Build a PsaSource from the environment (token generated on the PSA site). */
export function buildPsa(env: NodeJS.ProcessEnv = process.env): PsaSource {
  return new PsaSource({ accessToken: env.PSA_ACCESS_TOKEN?.trim() });
}
