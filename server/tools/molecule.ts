// Tool 3: show_molecule. The server resolves and checks the identifier; the widget downloads the structure.

import type { McpServer } from "@modelcontextprotocol/server";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { MoleculeInput, MoleculeOutput, queryOf, summarizeMolecule } from "../../shared/molecule.js";
import { LookupError, createLookup } from "../molecule/lookup.js";
import { loadWidget } from "../widgets.js";

export const MOLECULE_URI = "ui://maker-lab/molecule-v1.html";

/** The only hosts the widget may contact. Both serve public, CORS-enabled files. */
export const MOLECULE_CSP = {
  connectDomains: ["https://files.rcsb.org", "https://pubchem.ncbi.nlm.nih.gov"],
  resourceDomains: [] as string[], // 3Dmol.js is bundled into the widget, so no script or style hosts are needed
};

// One lookup object for the whole process: the cache and the rate limiter must outlive a single request.
const sharedLookup = createLookup();

const DESCRIPTION = `Show an interactive 3D structure of a protein, nucleic acid or small molecule.

Give exactly one of:
- pdb_id: a 4-character Protein Data Bank ID such as 4HHB (haemoglobin), 1CRN (crambin) or 6LU7. Use this for proteins, DNA/RNA and complexes. The structure is an experimental model from RCSB.
- compound_name: a small-molecule name that PubChem knows, such as caffeine, aspirin, glucose or an IUPAC name.
- smiles: a SMILES string for a small molecule, when you know the structure.
Leave the other two out.

For compound_name and smiles the 3D shape comes from PubChem and is a computed conformer, not an experimental structure. If the name is not found, or matches several compounds, the tool says so and lists candidates; do not guess. Retry with a more specific name or a smiles string. Entries with more than 120,000 atoms and compounds with no 3D record cannot be shown.

The widget has stick, sphere and cartoon (proteins only) styles, colouring by element or by chain, a spin toggle, and a panel with the name, formula, mass and a link to the source. Use it to explain structure and shape. This is for education only: never use it to make medical, dosing, toxicity, safety or engineering claims.`;

export function registerMolecule(server: McpServer, lookup = sharedLookup): void {
  registerAppResource(
    server,
    "Maker Lab molecule viewer",
    MOLECULE_URI,
    { description: "3Dmol.js viewer for show_molecule results.", mimeType: RESOURCE_MIME_TYPE },
    async () => ({
      contents: [
        {
          uri: MOLECULE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: loadWidget("molecule"),
          _meta: { ui: { csp: MOLECULE_CSP, prefersBorder: true } },
        },
      ],
    }),
  );

  registerAppTool(
    server,
    "show_molecule",
    {
      title: "Show molecule",
      description: DESCRIPTION,
      inputSchema: MoleculeInput,
      outputSchema: MoleculeOutput,
      annotations: {
        title: "Show molecule",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true, // it contacts the public RCSB and PubChem services
      },
      _meta: { ui: { resourceUri: MOLECULE_URI } },
    },
    async (input) => {
      try {
        const molecule = await lookup.resolve(queryOf(input));
        return { content: [{ type: "text" as const, text: summarizeMolecule(molecule) }], structuredContent: molecule };
      } catch (err) {
        if (err instanceof LookupError) return { isError: true, content: [{ type: "text" as const, text: err.message }] };
        throw err;
      }
    },
  );
}
