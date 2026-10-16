// Input and output schemas for show_molecule, and the plain-text summary.

import { z } from "zod";

export const DISCLAIMER = "Educational use only. Not for medical, dosing, safety or engineering decisions.";

export const PDB_ID = /^[1-9][A-Za-z0-9]{3}$/;
/** Characters that occur in SMILES: atoms, bonds, branches, rings, charges, stereo, wildcard. */
const SMILES_CHARS = /^[A-Za-z0-9@+\-[\]()\\/=#$:.%*]+$/;

export const MAX_NAME_LENGTH = 200;
export const MAX_SMILES_LENGTH = 500;

// Empty strings count as "not given": models often fill unused fields with "".
export const MoleculeInput = z
  .object({
    pdb_id: z.string().optional().describe("4-character Protein Data Bank ID, e.g. 4HHB (haemoglobin) or 1CRN. Digit 1–9 first, then 3 letters or digits."),
    compound_name: z.string().optional().describe(`Small-molecule name that PubChem knows, e.g. caffeine, aspirin, glucose, or an IUPAC name. At most ${MAX_NAME_LENGTH} characters.`),
    smiles: z.string().optional().describe(`SMILES string of a small molecule, e.g. CC(=O)OC1=CC=CC=C1C(=O)O. At most ${MAX_SMILES_LENGTH} characters.`),
  })
  .superRefine((input, ctx) => {
    const given = (["pdb_id", "compound_name", "smiles"] as const).filter((k) => (input[k] ?? "").trim() !== "");
    const add = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });

    if (given.length === 0) {
      ctx.addIssue({ code: "custom", message: "give exactly one of pdb_id, compound_name or smiles (none was given)" });
      return;
    }
    if (given.length > 1) {
      ctx.addIssue({ code: "custom", message: `give exactly one of pdb_id, compound_name or smiles, not ${given.join(" and ")}; leave the others out` });
      return;
    }
    const value = (input[given[0]!] ?? "").trim();
    if (given[0] === "pdb_id" && !PDB_ID.test(value)) {
      add("pdb_id", `pdb_id must be 4 characters: a digit 1–9 then 3 letters or digits, like 4HHB (got "${value}"). For a molecule that is not in the Protein Data Bank use compound_name or smiles`);
    }
    if (given[0] === "compound_name" && value.length > MAX_NAME_LENGTH) {
      add("compound_name", `compound_name must be at most ${MAX_NAME_LENGTH} characters; use a shorter name or a smiles string`);
    }
    if (given[0] === "smiles") {
      if (value.length > MAX_SMILES_LENGTH) add("smiles", `smiles must be at most ${MAX_SMILES_LENGTH} characters`);
      else if (!SMILES_CHARS.test(value)) {
        add("smiles", "smiles contains characters that cannot occur in SMILES (spaces, quotes or other symbols). Allowed: letters, digits and @ + - [ ] ( ) \\ / = # $ : . % *");
      }
    }
  });

export type MoleculeQuery = { kind: "pdb_id" | "compound_name" | "smiles"; value: string };

/** The single identifier the caller gave, trimmed. Call only after the schema has accepted the input. */
export function queryOf(input: z.infer<typeof MoleculeInput>): MoleculeQuery {
  for (const kind of ["pdb_id", "compound_name", "smiles"] as const) {
    const value = (input[kind] ?? "").trim();
    if (value !== "") return { kind, value };
  }
  throw new Error("no identifier given"); // unreachable after validation
}

export const MoleculeOutput = z.object({
  source: z.enum(["pdb", "pubchem"]),
  sourceName: z.string(),
  id: z.string().describe("PDB ID or PubChem CID"),
  name: z.string(),
  formula: z.string().nullable().describe("Molecular formula; null for macromolecules"),
  mass: z.string().nullable(),
  details: z.array(z.object({ label: z.string(), value: z.string() })),
  format: z.enum(["pdb", "cif", "sdf"]).describe("Format of the file at dataUrl"),
  dataUrl: z.string().describe("Public file the widget downloads and renders"),
  pageUrl: z.string(),
  query: z.object({ kind: z.enum(["pdb_id", "compound_name", "smiles"]), value: z.string() }),
  dataNote: z.string(),
  disclaimer: z.string(),
});

export type MoleculeOutput = z.infer<typeof MoleculeOutput>;

/** Plain-text report for clients that cannot show the widget. */
export function summarizeMolecule(m: MoleculeOutput): string {
  return [
    `${m.name} (${m.sourceName} ${m.id})`,
    ...(m.formula ? [`Formula: ${m.formula}`] : []),
    ...(m.mass ? [`Mass: ${m.mass}`] : []),
    ...m.details.map((d) => `${d.label}: ${d.value}`),
    `Source: ${m.pageUrl}`,
    `Structure file (${m.format}): ${m.dataUrl}`,
    m.dataNote,
    m.disclaimer,
  ].join("\n");
}
