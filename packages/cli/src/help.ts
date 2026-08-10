/**
 * Usage text.
 *
 * Kept as data rather than printf calls so `mdv help export` and `mdv export
 * --help` cannot drift apart, and so a test can assert that every command has
 * one.
 */

import { COMMAND_NAMES } from './args.js';
import type { CommandName } from './args.js';

/** One line per command, for the top-level listing. */
const SUMMARY: Readonly<Record<CommandName, string>> = {
  render: 'Render to the terminal, or to SVG with -o',
  export: 'Export: --to pdf|svg|json|csv',
  lint: 'Report diagnostics; --max-severity, --format',
  fmt: 'Canonical formatting; --check for CI',
  watch: 'Rebuild on change',
  data: "Print a block's resolved table",
  'validate-theme': 'Run the palette validator (SPEC 16.4)',
  init: 'Scaffold a document with front matter',
};

/** Per-command usage. */
const DETAIL: Readonly<Record<CommandName, string>> = {
  render: `mdv render <file.mdv> [-o <out.svg>]

Renders every visual block. With no -o, the text backend prints the accessible
name, the description and the table view — the same content a screen reader
gets. With -o, writes SVG; several blocks share the stem and take the block id
as a suffix.

  -o, --out <path>   SVG output path, or - for stdout
      --width <px>   Layout width in CSS pixels (default 800)
      --block <id>   Only this block (id, or 0-based index)
      --rows <n>     Table-view rows to print (default 10)`,

  export: `mdv export <file.mdv> [-o <out>] [--to <target>]

Targets: pdf, svg, json, csv. html, png and md are recognised and refused —
this build does not have them, and a truncated export is worse than an error.
The target is taken from --to, else from the -o extension, else pdf.

  -o, --out <path>        Output path, or - for stdout (not for pdf)
      --to <target>       pdf | svg | json | csv
      --width <px>        Layout width for svg/json (default 800)
      --block <id>        Only this block (svg, csv)
      --page-size <name>  A4, Letter, … (pdf)
      --orientation <o>   portrait | landscape (pdf)
      --profile <p>       pdf-1.7 | pdf-a-3b | pdf-ua-1
      --embed-source      Attach the .mdv to the PDF (SPEC 28.9)
      --no-compress       Uncompressed streams, for byte comparison`,

  lint: `mdv lint [<glob>...]

Parse, resolve and validate. Exits 1 when any diagnostic is at or above
--max-severity. A bare directory expands to the .mdv and .md files beneath it.

      --max-severity <s>  error | warning | info (default error)
      --format <f>        pretty | json | sarif (default pretty)`,

  fmt: `mdv fmt [<glob>...]

Rewrites each file in canonical form. The result is re-parsed and compared
before anything is written: formatting must not change the AST.

      --check   Write nothing; exit 1 if a file would change`,

  watch: `mdv watch <file.mdv> [-o <out>] [--to <target>]

Exports once, then again on every change. Accepts every mdv export flag.
--serve is not implemented in this build.`,

  data: `mdv data <file.mdv> [--block <id>] [--to csv|json|text]

Prints the table the block renders from, after src:, transforms and type
inference. Defaults to the first block, and to csv when stdout is not a tty.`,

  'validate-theme': `mdv validate-theme <file.json|name> [--scheme light|dark]

Runs the executable palette validator (SPEC 16.4) over a theme's categorical
palette: lightness band, chroma floor, CVD separation, contrast. Exits 1 on a
fail finding (MDV3080).`,

  init: `mdv init [<path>] [--force]

Writes a working scaffold document (default document.mdv).`,
};

/** The global usage text. */
export function globalHelp(version: string): string {
  const width = Math.max(...COMMAND_NAMES.map((name) => name.length));
  const commands = COMMAND_NAMES.map(
    (name) => `  ${name.padEnd(width)}  ${SUMMARY[name]}`,
  ).join('\n');

  return `mdv ${version} — Markdown Visual

Usage: mdv <command> [options]

Commands:
${commands}

Global flags:
      --config <path>     Configuration file (.json, .js)
      --theme <name|path> Built-in name, or a theme JSON file
      --level <1|2|3>     Conformance level to render at
      --strict            Promote every warning to an error
      --locale <tag>      BCP 47; never read from the host
      --timezone <tz>     IANA zone; never read from the host
      --build-time <iso>  Pins now(); required for byte-identical output
      --allow-external    Permit src: over the network
      --allow-file        Permit src: from the document's own directory
  -q, --quiet             Suppress status output on stderr
      --no-color          Never emit ANSI escapes
  -h, --help              This text, or a command's

Exit codes: 0 success · 1 diagnostics at or above --max-severity · 2 usage
error · 3 I/O error · 4 security refusal

Run \`mdv help <command>\` for detail.
`;
}

/** One command's usage text. */
export function commandHelp(command: CommandName): string {
  return `${DETAIL[command]}\n`;
}
