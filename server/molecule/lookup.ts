// Turns a PDB ID, compound name or SMILES into a verified, citable structure file URL.
//
// The server only resolves and checks (is there such an entry? is there a 3D structure?). The widget downloads
// the structure file itself from the same public hosts, which are listed in the widget's CSP.
//
// Politeness: results are cached in memory, identical in-flight lookups are shared, and requests to each host
// are spaced out. PubChem asks for at most 5 requests per second and 400 per minute; we stay at 4 and 300.

import { PDB_ID, type MoleculeOutput, type MoleculeQuery, DISCLAIMER } from "../../shared/molecule.js";

export const PUBCHEM = "https://pubchem.ncbi.nlm.nih.gov/rest/pug";
export const PUBCHEM_PAGE = "https://pubchem.ncbi.nlm.nih.gov/compound";
export const RCSB_DATA = "https://data.rcsb.org/rest/v1/core/entry";
export const RCSB_FILES = "https://files.rcsb.org/download";
export const RCSB_PAGE = "https://www.rcsb.org/structure";

/** Entries with more atoms than this would be slow or impossible to display in a chat widget. */
export const MAX_ATOMS = 120_000;
const CANDIDATES_SHOWN = 5;
const TIMEOUT_MS = 10_000;

/** A problem the caller can understand and act on. `permanent` ones (not found) are cached briefly. */
export class LookupError extends Error {
  constructor(
    message: string,
    readonly permanent = false,
  ) {
    super(message);
    this.name = "LookupError";
  }
}

export interface LookupDeps {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

// --- Cache ---------------------------------------------------------------------

/** Small in-memory cache with a time limit and a size limit. Holds promises, so concurrent lookups share one request. */
class TtlCache {
  private entries = new Map<string, { value: Promise<unknown>; expires: number }>();
  constructor(
    private max: number,
    private now: () => number,
  ) {}

  get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && hit.expires > this.now()) return hit.value as Promise<T>;

    const value = load();
    this.entries.set(key, { value, expires: this.now() + ttlMs });
    if (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!); // oldest first
    value.catch((err: unknown) => {
      // Transient failures must not stick; "not found" answers may, but only briefly.
      if (!(err instanceof LookupError && err.permanent)) this.entries.delete(key);
      else this.entries.set(key, { value, expires: this.now() + NEGATIVE_TTL_MS });
    });
    return value;
  }
}

const POSITIVE_TTL_MS = 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 5 * 60 * 1000;

// --- Rate limiting ----------------------------------------------------------------

class Limiter {
  private next = 0;
  private recent: number[] = [];
  private slowUntil = 0;
  private blockedUntil = 0;

  constructor(
    private host: string,
    private gapMs: number,
    private perMinute: number,
    private now: () => number,
    private sleep: (ms: number) => Promise<void>,
  ) {}

  /** Reserve the next request slot, waiting if needed. Throws if the host has told us to back off. */
  async acquire(): Promise<void> {
    const now = this.now();
    if (now < this.blockedUntil) {
      throw new LookupError(`${this.host} asked us to slow down. Try again in about ${Math.ceil((this.blockedUntil - now) / 1000)} seconds.`);
    }
    this.recent = this.recent.filter((t) => now - t < 60_000);
    if (this.recent.length >= this.perMinute) {
      throw new LookupError(`Too many requests to ${this.host} in the last minute (limit ${this.perMinute}). Wait a minute and try again.`);
    }
    const start = Math.max(now, this.next);
    this.next = start + (now < this.slowUntil ? this.gapMs * 2 : this.gapMs);
    this.recent.push(start);
    if (start > now) await this.sleep(start - now);
  }

  /** PubChem reports its load in X-Throttling-Control, e.g. "Request Count status: Green (0%), …". */
  observe(header: string | null): void {
    if (!header) return;
    if (/\b(Red|Black)\b/.test(header)) this.blockedUntil = this.now() + 60_000;
    else if (/\bYellow\b/.test(header)) this.slowUntil = this.now() + 60_000;
  }
}

// --- Lookup ---------------------------------------------------------------------------

interface HttpResult {
  status: number;
  text: string;
}

interface PropertyRow {
  CID: number;
  Title?: string;
  IUPACName?: string;
  MolecularFormula?: string;
  MolecularWeight?: string;
  SMILES?: string;
}

export function createLookup(deps: LookupDeps = {}) {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const cache = new TtlCache(500, now);
  const pubchemLimiter = new Limiter("PubChem", 250, 300, now, sleep);
  const rcsbLimiter = new Limiter("RCSB", 200, 600, now, sleep);

  async function http(limiter: Limiter, service: string, url: string, init?: RequestInit): Promise<HttpResult> {
    await limiter.acquire();
    let response: Response;
    try {
      response = await doFetch(url, {
        ...init,
        headers: { Accept: "application/json, text/plain", "User-Agent": "maker-lab-educational-mcp-app", ...init?.headers },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new LookupError(`Could not reach ${service} (network error or no answer within ${TIMEOUT_MS / 1000} seconds). Try again in a moment.`);
    }
    limiter.observe(response.headers.get("x-throttling-control"));
    if (response.status === 429 || response.status === 503 || response.status === 504) {
      throw new LookupError(`${service} is busy or limiting requests right now (HTTP ${response.status}). Wait about 30 seconds and try again.`);
    }
    return { status: response.status, text: await response.text() };
  }

  const pubchem = (path: string, init?: RequestInit) => http(pubchemLimiter, "PubChem", `${PUBCHEM}${path}`, init);
  const rcsb = (url: string) => http(rcsbLimiter, "RCSB", url);

  function parseJson<T>(result: HttpResult, service: string): T {
    try {
      return JSON.parse(result.text) as T;
    } catch {
      throw new LookupError(`${service} returned something that is not valid JSON (HTTP ${result.status}); try again later.`);
    }
  }

  // --- PDB ---------------------------------------------------------------------------

  function resolvePdb(rawId: string): Promise<MoleculeOutput> {
    const id = rawId.trim().toUpperCase();
    return cache.get(`pdb:${id}`, POSITIVE_TTL_MS, async () => {
      if (!PDB_ID.test(id)) throw new LookupError(`"${rawId}" is not a PDB ID (4 characters like 4HHB).`, true);
      const { status, text } = await rcsb(`${RCSB_DATA}/${id}`);
      if (status === 404) {
        throw new LookupError(
          `No entry "${id}" exists in the RCSB Protein Data Bank. Check the ID (e.g. 4HHB, 1CRN, 6LU7), or use compound_name or smiles for a small molecule.`,
          true,
        );
      }
      if (status !== 200) throw new LookupError(`RCSB answered with HTTP ${status} for ${id}; try again later.`);
      return pdbOutput(id, parseJson<RcsbEntry>({ status, text }, "RCSB"), { kind: "pdb_id", value: rawId.trim() });
    });
  }

  // --- PubChem ------------------------------------------------------------------------

  async function candidateCids(query: MoleculeQuery): Promise<number[]> {
    const isName = query.kind === "compound_name";
    const field = isName ? "name" : "smiles";
    const { status, text } = await pubchem(`/compound/${field}/cids/JSON`, {
      method: "POST", // in the body, so special characters in names and SMILES need no URL escaping
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `${field}=${encodeURIComponent(query.value)}`,
    });
    if (status === 404) {
      throw new LookupError(
        isName
          ? `PubChem has no compound named "${query.value}". Check the spelling, try a common synonym or the IUPAC name (e.g. "acetylsalicylic acid"), or pass a smiles string instead.`
          : `PubChem has no compound with the SMILES "${query.value}". It may not be a known compound; try compound_name, or check the SMILES.`,
        true,
      );
    }
    if (status === 400) {
      throw new LookupError(
        isName
          ? `PubChem could not use "${query.value}" as a name. Remove unusual characters or try a different name.`
          : `PubChem could not parse "${query.value}" as a SMILES string. Check brackets, ring numbers and atom symbols, or use compound_name.`,
        true,
      );
    }
    if (status !== 200) throw new LookupError(`PubChem answered with HTTP ${status}; try again later.`);
    const body = parseJson<{ IdentifierList?: { CID?: number[] } }>({ status, text }, "PubChem");
    return (body.IdentifierList?.CID ?? []).filter((cid) => cid > 0); // CID 0 means "no match"
  }

  async function properties(cids: number[]): Promise<PropertyRow[]> {
    const { status, text } = await pubchem(`/compound/cid/${cids.join(",")}/property/Title,IUPACName,MolecularFormula,MolecularWeight,SMILES/JSON`);
    if (status !== 200) throw new LookupError(`PubChem could not return details for CID ${cids.join(", ")} (HTTP ${status}); try again later.`);
    return parseJson<{ PropertyTable?: { Properties?: PropertyRow[] } }>({ status, text }, "PubChem").PropertyTable?.Properties ?? [];
  }

  function resolvePubchem(query: MoleculeQuery): Promise<MoleculeOutput> {
    const key = `${query.kind}:${query.kind === "compound_name" ? query.value.toLowerCase() : query.value}`;
    return cache.get(key, POSITIVE_TTL_MS, async () => {
      const cids = await candidateCids(query);
      if (cids.length === 0) {
        throw new LookupError(`PubChem found no compound for ${describe(query)}. Check it, or try a synonym or a smiles string.`, true);
      }
      if (cids.length > 1) {
        const shown = await properties(cids.slice(0, CANDIDATES_SHOWN));
        const lines = shown.map((p) => `- CID ${p.CID}: ${p.Title ?? p.IUPACName ?? "(no title)"}${p.MolecularFormula ? `, ${p.MolecularFormula}` : ""}${p.SMILES ? `, SMILES ${p.SMILES}` : ""}`);
        throw new LookupError(
          `${describe(query)} matches ${cids.length} PubChem compounds, so I did not pick one.${cids.length > shown.length ? ` The first ${shown.length} are:` : " They are:"}\n${lines.join("\n")}\n` +
            `Call show_molecule again with a more specific compound_name, or with the smiles of the one you mean.`,
          true,
        );
      }
      return pubchemOutput(cids[0]!, query);
    });
  }

  async function pubchemOutput(cid: number, query: MoleculeQuery): Promise<MoleculeOutput> {
    return cache.get(`cid:${cid}`, POSITIVE_TTL_MS, async () => {
      const dataPath = `/compound/cid/${cid}/SDF?record_type=3d`;
      const sdf = await pubchem(dataPath);
      if (sdf.status === 404) {
        throw new LookupError(
          `PubChem compound CID ${cid} has no 3D structure (common for large molecules, salts and mixtures). Try a smaller related compound, or the protein's pdb_id if it is a protein.`,
          true,
        );
      }
      if (sdf.status !== 200) throw new LookupError(`PubChem answered with HTTP ${sdf.status} for the 3D structure of CID ${cid}; try again later.`);
      const atoms = Number.parseInt(sdf.text.split("\n")[3]?.slice(0, 3) ?? "", 10); // SDF counts line: "aaabbb…"

      const [p] = await properties([cid]);
      const name = p?.Title ?? p?.IUPACName ?? `PubChem compound ${cid}`;
      const details = [
        { label: "PubChem CID", value: String(cid) },
        ...(p?.IUPACName && p.IUPACName !== name ? [{ label: "IUPAC name", value: p.IUPACName }] : []),
        ...(p?.SMILES ? [{ label: "SMILES", value: p.SMILES }] : []),
        ...(Number.isFinite(atoms) ? [{ label: "Atoms (including hydrogens)", value: String(atoms) }] : []),
      ];
      return {
        source: "pubchem" as const,
        sourceName: "PubChem",
        id: String(cid),
        name,
        formula: p?.MolecularFormula ?? null,
        mass: p?.MolecularWeight ? `${p.MolecularWeight} g/mol` : null,
        details,
        format: "sdf" as const,
        dataUrl: `${PUBCHEM}${dataPath}`,
        pageUrl: `${PUBCHEM_PAGE}/${cid}`,
        query,
        dataNote: "The 3D shape is a computed conformer from PubChem (one plausible shape), not an experimental structure.",
        disclaimer: DISCLAIMER,
      };
    });
  }

  return {
    pdb: resolvePdb,
    pubchem: resolvePubchem,
    resolve(query: MoleculeQuery): Promise<MoleculeOutput> {
      return query.kind === "pdb_id" ? resolvePdb(query.value) : resolvePubchem(query);
    },
  };
}

function describe(query: MoleculeQuery): string {
  return query.kind === "smiles" ? `the SMILES "${query.value}"` : `the name "${query.value}"`;
}

// --- RCSB entry → output --------------------------------------------------------------------

interface RcsbEntry {
  struct?: { title?: string };
  exptl?: { method?: string }[];
  struct_keywords?: { text?: string };
  rcsb_accession_info?: { initial_release_date?: string };
  pdbx_database_status?: { pdb_format_compatible?: string };
  rcsb_entry_info?: {
    molecular_weight?: number;
    deposited_atom_count?: number;
    deposited_model_count?: number;
    resolution_combined?: number[];
    polymer_entity_count?: number;
    polymer_composition?: string;
    nonpolymer_entity_count?: number;
  };
}

function sentenceCase(title: string): string {
  return /[a-z]/.test(title) ? title : title.charAt(0) + title.slice(1).toLowerCase(); // titles are often ALL CAPS
}

function pdbOutput(id: string, e: RcsbEntry, query: MoleculeQuery): MoleculeOutput {
  const info = e.rcsb_entry_info ?? {};
  const atoms = info.deposited_atom_count;
  if (atoms !== undefined && atoms > MAX_ATOMS) {
    throw new LookupError(
      `PDB entry ${id} has ${atoms.toLocaleString("en-US")} atoms, too many to display in a chat widget (limit ${MAX_ATOMS.toLocaleString("en-US")}). Choose a smaller entry.`,
      true,
    );
  }
  // Very large entries have no legacy .pdb file; RCSB marks which entries do.
  const format = e.pdbx_database_status?.pdb_format_compatible === "N" ? ("cif" as const) : ("pdb" as const);
  const resolution = info.resolution_combined?.[0];
  const release = e.rcsb_accession_info?.initial_release_date?.slice(0, 10);
  const keywords = e.struct_keywords?.text;

  const details = [
    { label: "PDB ID", value: id },
    ...(e.exptl?.[0]?.method ? [{ label: "Method", value: e.exptl[0].method.toLowerCase() }] : []),
    ...(resolution !== undefined ? [{ label: "Resolution", value: `${resolution} Å` }] : []),
    ...(atoms !== undefined ? [{ label: "Atoms", value: atoms.toLocaleString("en-US") }] : []),
    ...(info.polymer_entity_count !== undefined ? [{ label: "Distinct polymers", value: `${info.polymer_entity_count}${info.polymer_composition ? ` (${info.polymer_composition})` : ""}` }] : []),
    ...(info.deposited_model_count && info.deposited_model_count > 1 ? [{ label: "Models", value: `${info.deposited_model_count} (the first is shown)` }] : []),
    ...(keywords ? [{ label: "Keywords", value: keywords.length > 140 ? `${keywords.slice(0, 137)}…` : keywords }] : []),
    ...(release ? [{ label: "Released", value: release }] : []),
  ];
  return {
    source: "pdb",
    sourceName: "RCSB Protein Data Bank",
    id,
    name: sentenceCase(e.struct?.title ?? `PDB entry ${id}`),
    formula: null,
    mass: info.molecular_weight !== undefined ? `${info.molecular_weight} kDa (all deposited chains)` : null,
    details,
    format,
    dataUrl: `${RCSB_FILES}/${id}.${format}`,
    pageUrl: `${RCSB_PAGE}/${id}`,
    query,
    dataNote: "An experimental model fitted to measured data; check the resolution and validation reports on RCSB before drawing conclusions from fine detail.",
    disclaimer: DISCLAIMER,
  };
}
