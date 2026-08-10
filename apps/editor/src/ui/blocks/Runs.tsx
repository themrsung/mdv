/**
 * Inline runs.
 *
 * One element per run, carrying `data-mdv-run`, with the marks nested *inside*
 * it. Putting the index on the outside means the run wrapper is always the
 * element the mapper finds, whatever the marks are, and that there is exactly
 * one text node at the bottom of each run — no browser normalisation to fight
 * and no ambiguity about which node a `Range` should address.
 *
 * `memo` is not an optimisation here, it is a correctness requirement. While an
 * input method is composing, the browser owns this subtree; the engine has not
 * changed, so the `runs` array is referentially identical and React bails out
 * before it can overwrite what the IME wrote.
 *
 * The attribute names are spelled literally below and as constants in
 * `../dom/contract.ts`; `test/ui/dom-contract.test.ts` asserts the two agree.
 */

import { memo } from 'react';
import type { ReactNode } from 'react';
import type { Mark, Run } from '../../engine/index.js';
import { runsText, sortMarks } from '../../engine/index.js';

function wrapInMark(mark: Mark, children: ReactNode): ReactNode {
  switch (mark.type) {
    case 'strong':
      return <strong className="mdv-strong">{children}</strong>;
    case 'emphasis':
      return <em className="mdv-em">{children}</em>;
    case 'strikethrough':
      return <s className="mdv-del">{children}</s>;
    case 'code':
      return <code className="mdv-code-inline">{children}</code>;
    case 'link':
      // Not an `<a>`: a live link inside a contenteditable region is a trap —
      // clicking it navigates away mid-edit, and Ctrl-clicking is
      // undiscoverable. The destination is shown by the link inspector instead.
      return (
        <span className="mdv-link" data-href={mark.href} title={mark.title ?? mark.href}>
          {children}
        </span>
      );
  }
}

function RunViewImpl({ run, index }: { readonly run: Run; readonly index: number }): ReactNode {
  if (run.kind === 'raw') {
    return (
      <span
        data-mdv-run={index}
        className="mdv-run mdv-run--raw"
        title={`Raw source: ${run.source}`}
      >
        {run.text}
      </span>
    );
  }

  let content: ReactNode = run.text;
  const marks = sortMarks(run.marks);
  for (let position = marks.length - 1; position >= 0; position -= 1) {
    const mark = marks[position];
    if (mark !== undefined) content = wrapInMark(mark, content);
  }

  return (
    <span data-mdv-run={index} className="mdv-run">
      {content}
    </span>
  );
}

const RunView = memo(RunViewImpl);

/**
 * The full run list of one container.
 *
 * An empty container gets a filler `<br>`: without it the line has no box, so
 * the block collapses to zero height and there is nowhere to put the caret. It
 * is marked so the offset mapper knows it contributes no text.
 */
function RunsViewImpl({ runs }: { readonly runs: readonly Run[] }): ReactNode {
  const empty = runs.length === 0 || runsText(runs) === '';
  return (
    <>
      {runs.map((run, index) => (
        <RunView key={run.id} run={run} index={index} />
      ))}
      {empty ? <br data-mdv-filler="true" /> : null}
    </>
  );
}

export const RunsView = memo(RunsViewImpl);
