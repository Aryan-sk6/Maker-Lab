import { describe, expect, it } from "vitest";
import { MoleculeInput, queryOf } from "./molecule.js";

function errors(input: unknown): string[] {
  const result = MoleculeInput.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`.replace(/^: /, ""));
}

describe("show_molecule input validation", () => {
  it.each([{ pdb_id: "4HHB" }, { pdb_id: "1crn" }, { compound_name: "caffeine" }, { smiles: "CC(=O)OC1=CC=CC=C1C(=O)O" }, { smiles: "C[C@@H](C(=O)O)N" }, { smiles: "[Na+].[Cl-]" }])(
    "accepts %j",
    (input) => {
      expect(errors(input)).toEqual([]);
    },
  );

  it("requires exactly one identifier", () => {
    expect(errors({})[0]).toContain("exactly one of pdb_id, compound_name or smiles (none was given)");
    expect(errors({ pdb_id: "4HHB", smiles: "CCO" })[0]).toContain("not pdb_id and smiles; leave the others out");
    expect(errors({ pdb_id: "4HHB", compound_name: "x", smiles: "CCO" })[0]).toContain("pdb_id and compound_name and smiles");
  });

  it("treats empty strings as not given, since models often fill unused fields with them", () => {
    expect(errors({ pdb_id: "", compound_name: "caffeine", smiles: "  " })).toEqual([]);
    expect(queryOf({ pdb_id: "", compound_name: "  caffeine  ", smiles: "" })).toEqual({ kind: "compound_name", value: "caffeine" });
    expect(errors({ pdb_id: "", smiles: "" })[0]).toContain("none was given");
  });

  it.each(["4HH", "4HHBB", "0ABC", "4HH!", "hhb4"])("rejects the PDB ID %j and explains the format", (pdb_id) => {
    expect(errors({ pdb_id })[0]).toMatch(/^pdb_id: pdb_id must be 4 characters: a digit 1–9 then 3 letters or digits, like 4HHB/);
  });

  it("rejects characters that cannot occur in a SMILES string", () => {
    expect(errors({ smiles: "CC O" })[0]).toContain("smiles contains characters that cannot occur in SMILES");
    expect(errors({ smiles: "CCO; DROP TABLE" })[0]).toContain("smiles contains characters");
    expect(errors({ smiles: "<script>" })[0]).toContain("smiles contains characters");
  });

  it("limits the length of names and SMILES", () => {
    expect(errors({ compound_name: "a".repeat(201) })[0]).toContain("at most 200 characters");
    expect(errors({ smiles: "C".repeat(501) })[0]).toContain("at most 500 characters");
  });
});
