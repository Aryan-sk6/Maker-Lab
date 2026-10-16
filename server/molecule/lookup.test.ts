// Lookup logic against a fake network: no real requests are made. The response shapes below were
// checked against the live RCSB and PubChem services (see ARCHITECTURE.md).

import { describe, expect, it } from "vitest";
import { LookupError, MAX_ATOMS, createLookup } from "./lookup.js";

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

/** A fetch that answers from a table of "METHOD path-prefix" → response and records every call. */
function fakeNetwork(routes: Record<string, Handler>) {
  const calls: { method: string; url: string; body?: string; at: number }[] = [];
  const clock = { t: 1_000_000 };
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body as string | undefined, at: clock.t });
    const key = Object.keys(routes).find((k) => `${method} ${url}`.startsWith(k));
    if (!key) return new Response("no route", { status: 500 });
    return routes[key]!(url, init);
  }) as typeof fetch;
  const lookup = createLookup({
    fetch: fetchFn,
    now: () => clock.t,
    sleep: async (ms) => void (clock.t += ms),
  });
  return { lookup, calls, clock };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const PC = "https://pubchem.ncbi.nlm.nih.gov/rest/pug";
const ASPIRIN_PROPS = { PropertyTable: { Properties: [{ CID: 2244, Title: "Aspirin", IUPACName: "2-acetyloxybenzoic acid", MolecularFormula: "C9H8O4", MolecularWeight: "180.16", SMILES: "CC(=O)OC1=CC=CC=C1C(=O)O" }] } };
const SDF = "2244\n  -OEChem-\n\n 21 21  0     0  0  0  0  0  0999 V2000\n";

const pubchemRoutes = (): Record<string, Handler> => ({
  [`POST ${PC}/compound/name/cids/JSON`]: () => json({ IdentifierList: { CID: [2244] } }),
  [`GET ${PC}/compound/cid/2244/SDF`]: () => new Response(SDF),
  [`GET ${PC}/compound/cid/2244/property`]: () => json(ASPIRIN_PROPS),
});

const rcsbEntry = (over: object = {}) => ({
  struct: { title: "THE CRYSTAL STRUCTURE OF HUMAN DEOXYHAEMOGLOBIN AT 1.74 ANGSTROMS RESOLUTION" },
  exptl: [{ method: "X-RAY DIFFRACTION" }],
  struct_keywords: { text: "OXYGEN TRANSPORT" },
  rcsb_accession_info: { initial_release_date: "1984-07-17T00:00:00+0000" },
  pdbx_database_status: { pdb_format_compatible: "Y" },
  rcsb_entry_info: { molecular_weight: 64.74, deposited_atom_count: 4779, resolution_combined: [1.74], polymer_entity_count: 2, polymer_composition: "heteromeric protein", deposited_model_count: 1 },
  ...over,
});

describe("PDB lookup", () => {
  it("returns the title, facts and the RCSB file URL", async () => {
    const { lookup, calls } = fakeNetwork({ "GET https://data.rcsb.org/rest/v1/core/entry/4HHB": () => json(rcsbEntry()) });
    const m = await lookup.resolve({ kind: "pdb_id", value: "4hhb" });
    expect(calls).toHaveLength(1);
    expect(m).toMatchObject({
      source: "pdb",
      id: "4HHB",
      name: "The crystal structure of human deoxyhaemoglobin at 1.74 angstroms resolution",
      formula: null,
      mass: "64.74 kDa (all deposited chains)",
      format: "pdb",
      dataUrl: "https://files.rcsb.org/download/4HHB.pdb",
      pageUrl: "https://www.rcsb.org/structure/4HHB",
    });
    expect(m.details).toContainEqual({ label: "Resolution", value: "1.74 Å" });
    expect(m.details).toContainEqual({ label: "Atoms", value: "4,779" });
    expect(m.details).toContainEqual({ label: "Released", value: "1984-07-17" });
  });

  it("uses the mmCIF file when RCSB has no .pdb file for the entry", async () => {
    const { lookup } = fakeNetwork({ "GET https://data.rcsb.org/": () => json(rcsbEntry({ pdbx_database_status: { pdb_format_compatible: "N" } })) });
    const m = await lookup.resolve({ kind: "pdb_id", value: "7K00" });
    expect(m).toMatchObject({ format: "cif", dataUrl: "https://files.rcsb.org/download/7K00.cif" });
  });

  it("says so when the entry does not exist, and suggests alternatives", async () => {
    const { lookup } = fakeNetwork({ "GET https://data.rcsb.org/": () => json({ status: 404, message: "No data found for entryId: 9XXX" }, 404) });
    await expect(lookup.resolve({ kind: "pdb_id", value: "9XXX" })).rejects.toThrow(/No entry "9XXX" exists.*compound_name or smiles/);
  });

  it("refuses entries too big for a chat widget", async () => {
    const { lookup } = fakeNetwork({ "GET https://data.rcsb.org/": () => json(rcsbEntry({ rcsb_entry_info: { deposited_atom_count: MAX_ATOMS + 1 } })) });
    await expect(lookup.resolve({ kind: "pdb_id", value: "4V4F" })).rejects.toThrow(/too many to display.*Choose a smaller entry/);
  });

  it("only mentions multiple models when there are several", async () => {
    const { lookup } = fakeNetwork({ "GET https://data.rcsb.org/": () => json(rcsbEntry({ rcsb_entry_info: { deposited_model_count: 20, deposited_atom_count: 900 } })) });
    expect((await lookup.resolve({ kind: "pdb_id", value: "1D3Z" })).details).toContainEqual({ label: "Models", value: "20 (the first is shown)" });
  });
});

describe("PubChem lookup by name", () => {
  it("resolves a name to a verified 3D conformer URL", async () => {
    const { lookup, calls } = fakeNetwork(pubchemRoutes());
    const m = await lookup.resolve({ kind: "compound_name", value: "Aspirin" });
    expect(m).toMatchObject({
      source: "pubchem",
      id: "2244",
      name: "Aspirin",
      formula: "C9H8O4",
      mass: "180.16 g/mol",
      format: "sdf",
      dataUrl: `${PC}/compound/cid/2244/SDF?record_type=3d`,
      pageUrl: "https://pubchem.ncbi.nlm.nih.gov/compound/2244",
    });
    expect(m.details).toContainEqual({ label: "Atoms (including hydrogens)", value: "21" });
    expect(m.details).toContainEqual({ label: "IUPAC name", value: "2-acetyloxybenzoic acid" });
    // The name goes in the POST body, URL-encoded, never in the URL.
    expect(calls[0]).toMatchObject({ method: "POST", body: "name=Aspirin" });
    expect(calls[0]!.url).not.toContain("Aspirin");
  });

  it("encodes special characters in the request body", async () => {
    const { lookup, calls } = fakeNetwork(pubchemRoutes());
    await lookup.resolve({ kind: "compound_name", value: "2-(acetyloxy)benzoic acid" });
    expect(calls[0]!.body).toBe("name=2-(acetyloxy)benzoic%20acid");
  });

  it("explains a name PubChem does not know", async () => {
    const { lookup } = fakeNetwork({ [`POST ${PC}/compound/name/cids/JSON`]: () => json({ Fault: { Code: "PUGREST.NotFound" } }, 404) });
    await expect(lookup.resolve({ kind: "compound_name", value: "xylene" })).rejects.toThrow(/no compound named "xylene".*synonym.*smiles/s);
  });

  it("does not pick one when several compounds match, and lists candidates with SMILES", async () => {
    const { lookup, calls } = fakeNetwork({
      [`POST ${PC}/compound/name/cids/JSON`]: () => json({ IdentifierList: { CID: [11, 22, 33, 44, 55, 66, 77] } }),
      [`GET ${PC}/compound/cid/11,22,33,44,55/property`]: () =>
        json({ PropertyTable: { Properties: [{ CID: 11, Title: "Alpha", MolecularFormula: "C2H6O", SMILES: "CCO" }, { CID: 22, Title: "Beta", MolecularFormula: "C3H8O", SMILES: "CCCO" }] } }),
    });
    const err = await lookup.resolve({ kind: "compound_name", value: "thing" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LookupError);
    const message = (err as LookupError).message;
    expect(message).toContain('matches 7 PubChem compounds, so I did not pick one');
    expect(message).toContain("The first 2 are:"); // only the rows PubChem returned
    expect(message).toContain("- CID 11: Alpha, C2H6O, SMILES CCO");
    expect(message).toContain("more specific compound_name, or with the smiles");
    expect(calls.some((c) => c.url.includes("/SDF"))).toBe(false); // never fetched a structure for a guess
  });

  it("treats CID 0 as no match", async () => {
    const { lookup } = fakeNetwork({ [`POST ${PC}/compound/smiles/cids/JSON`]: () => json({ IdentifierList: { CID: [0] } }) });
    await expect(lookup.resolve({ kind: "smiles", value: "CCCCCCCCCCCCCCCCCCCCC" })).rejects.toThrow(/found no compound for the SMILES/);
  });

  it("says when a compound has no 3D structure", async () => {
    const { lookup } = fakeNetwork({
      [`POST ${PC}/compound/name/cids/JSON`]: () => json({ IdentifierList: { CID: [70678557] } }),
      [`GET ${PC}/compound/cid/70678557/SDF`]: () => new Response("", { status: 404 }),
    });
    await expect(lookup.resolve({ kind: "compound_name", value: "insulin" })).rejects.toThrow(/CID 70678557 has no 3D structure.*large molecules.*pdb_id/);
  });
});

describe("PubChem lookup by SMILES", () => {
  it("posts the SMILES in the body and resolves it", async () => {
    const { lookup, calls } = fakeNetwork({ ...pubchemRoutes(), [`POST ${PC}/compound/smiles/cids/JSON`]: () => json({ IdentifierList: { CID: [2244] } }) });
    const m = await lookup.resolve({ kind: "smiles", value: "CC(=O)OC1=CC=CC=C1C(=O)O" });
    expect(m.id).toBe("2244");
    expect(calls[0]!.body).toBe(`smiles=${encodeURIComponent("CC(=O)OC1=CC=CC=C1C(=O)O")}`);
    expect(calls[0]!.url).not.toContain("CC(");
  });

  it("explains an unparsable SMILES", async () => {
    const { lookup } = fakeNetwork({ [`POST ${PC}/compound/smiles/cids/JSON`]: () => json({ Fault: { Code: "PUGREST.BadRequest" } }, 400) });
    await expect(lookup.resolve({ kind: "smiles", value: "C1CC(" })).rejects.toThrow(/could not parse "C1CC\(" as a SMILES string.*brackets, ring numbers/);
  });
});

describe("caching", () => {
  it("answers repeat lookups from memory", async () => {
    const { lookup, calls } = fakeNetwork(pubchemRoutes());
    await lookup.resolve({ kind: "compound_name", value: "aspirin" });
    const after = calls.length;
    await lookup.resolve({ kind: "compound_name", value: "ASPIRIN" }); // names are case-insensitive keys
    expect(calls).toHaveLength(after);
  });

  it("shares one request between concurrent identical lookups", async () => {
    const { lookup, calls } = fakeNetwork({ "GET https://data.rcsb.org/": () => json(rcsbEntry()) });
    await Promise.all([1, 2, 3].map(() => lookup.resolve({ kind: "pdb_id", value: "4HHB" })));
    expect(calls).toHaveLength(1);
  });

  it("remembers 'not found' briefly, then asks again", async () => {
    const { lookup, calls, clock } = fakeNetwork({ "GET https://data.rcsb.org/": () => json({}, 404) });
    await expect(lookup.pdb("9XXX")).rejects.toThrow();
    await expect(lookup.pdb("9XXX")).rejects.toThrow();
    expect(calls).toHaveLength(1);
    clock.t += 6 * 60 * 1000;
    await expect(lookup.pdb("9XXX")).rejects.toThrow();
    expect(calls).toHaveLength(2);
  });

  it("does not cache a transient failure", async () => {
    let up = false;
    const { lookup, calls } = fakeNetwork({ "GET https://data.rcsb.org/": () => (up ? json(rcsbEntry()) : new Response("", { status: 503 })) });
    await expect(lookup.pdb("4HHB")).rejects.toThrow(/busy or limiting requests/);
    up = true;
    await expect(lookup.pdb("4HHB")).resolves.toMatchObject({ id: "4HHB" });
    expect(calls).toHaveLength(2);
  });
});

describe("failures and rate limits", () => {
  it("turns a network error into a readable message", async () => {
    const lookup = createLookup({
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    await expect(lookup.pdb("4HHB")).rejects.toThrow(/Could not reach RCSB.*Try again/);
  });

  it("spaces PubChem requests at least 250 ms apart (max 4 per second)", async () => {
    const { lookup, calls } = fakeNetwork({
      [`POST ${PC}/compound/name/cids/JSON`]: () => json({ IdentifierList: { CID: [2244] } }),
      [`GET ${PC}/compound/cid/2244/SDF`]: () => new Response(SDF),
      [`GET ${PC}/compound/cid/2244/property`]: () => json(ASPIRIN_PROPS),
    });
    await lookup.resolve({ kind: "compound_name", value: "aspirin" }); // 3 requests
    const gaps = calls.slice(1).map((c, i) => c.at - calls[i]!.at);
    expect(calls).toHaveLength(3);
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(250);
  });

  it("refuses to exceed 300 PubChem requests in a minute", async () => {
    // Frozen clock and no real waiting: all 305 lookups reserve their slots at the same instant,
    // so the last 5 find the minute's budget used up.
    const lookup = createLookup({
      fetch: (async () => json({}, 404)) as typeof fetch,
      now: () => 1_000_000,
      sleep: async () => {},
    });
    const results = await Promise.allSettled(Array.from({ length: 305 }, (_, i) => lookup.resolve({ kind: "compound_name", value: `name${i}` })));
    const limited = results.filter((r) => r.status === "rejected" && /Too many requests to PubChem in the last minute \(limit 300\)/.test(String(r.reason.message)));
    expect(limited).toHaveLength(5);
  });

  it("backs off for a minute when PubChem reports it is overloaded", async () => {
    const { lookup, calls, clock } = fakeNetwork({
      [`POST ${PC}/compound/name/cids/JSON`]: () => json({ Fault: {} }, 404, { "x-throttling-control": "Request Count status: Red (90%), Request Time status: Green (0%), Service status: Green (37%)" }),
    });
    await expect(lookup.resolve({ kind: "compound_name", value: "a" })).rejects.toThrow(/no compound named/);
    await expect(lookup.resolve({ kind: "compound_name", value: "b" })).rejects.toThrow(/asked us to slow down. Try again in about \d+ seconds/);
    expect(calls).toHaveLength(1); // the second lookup never left the server
    clock.t += 61_000;
    await expect(lookup.resolve({ kind: "compound_name", value: "c" })).rejects.toThrow(/no compound named/);
  });

  it("doubles the spacing when PubChem reports Yellow load", async () => {
    const { lookup, calls } = fakeNetwork({
      [`POST ${PC}/compound/name/cids/JSON`]: () => json({ Fault: {} }, 404, { "x-throttling-control": "Request Count status: Yellow (60%)" }),
    });
    await lookup.resolve({ kind: "compound_name", value: "a" }).catch(() => {});
    await lookup.resolve({ kind: "compound_name", value: "b" }).catch(() => {});
    await lookup.resolve({ kind: "compound_name", value: "c" }).catch(() => {});
    expect(calls[2]!.at - calls[1]!.at).toBeGreaterThanOrEqual(500);
  });
});
