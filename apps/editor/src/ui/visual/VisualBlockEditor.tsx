/**
 * The visual-block editor.
 *
 * Three views of one block, all writing to the same engine node:
 *
 * 1. **Preview** — the real renderer, or an honest notice when it cannot draw
 *    ({@link ChartPreview}).
 * 2. **Form** — block type, top-level header attributes, and the data section.
 * 3. **Source** — the block body verbatim, for anything the form cannot express.
 *
 * The form edits the header through the engine's `setHeaderAttribute`, which
 * rewrites one line and leaves the rest of the section byte-for-byte alone:
 * comments, key order, quoting style and nested mappings all survive being
 * edited by a UI that does not understand them. Re-serialising the parsed map
 * instead would quietly reformat the author's file on the first click, which is
 * the single most common way a structured editor loses trust.
 *
 * Nested mappings, sequences and multiline scalars are shown read-only with a
 * pointer at the source box. That is a real limit, and it is stated rather than
 * hidden behind a control that would mangle them.
 *
 * SPEC 5.1's determinism rule is the reason the "data section" toggle exists at
 * all: a body with no `---` is entirely a header, so "no data" and "empty data"
 * are different documents. `data: null` writes no separator; `data: ''` writes
 * one.
 */

import { memo, useCallback, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import type { VisualBlock } from '../../engine/index.js';
import type { AttrValue } from '../../engine/io/index.js';
import { commands, io } from '../../engine/index.js';
import { useEditorApi } from '../state/store.js';
import { ChartPreview } from './ChartPreview.js';

/**
 * Block types the picker offers, in SPEC order: §8.2–8.11 (Level 1), §8.12
 * (Level 2 and 3), then §5.2's reserved non-chart types. Free text is still
 * accepted — an unknown type is §15.2 fallback behaviour, not an error.
 */
const KNOWN_TYPES: readonly string[] = [
  'bar',
  'line',
  'area',
  'pie',
  'donut',
  'scatter',
  'bubble',
  'histogram',
  'box',
  'heatmap',
  'ohlc',
  'ohlcv',
  'candlestick',
  'metric',
  'table',
  'radar',
  'gauge',
  'funnel',
  'waterfall',
  'treemap',
  'sankey',
  'gantt',
  'sparkline',
  'map',
  'network',
  'dataset',
  'config',
  'theme',
  'include',
  'raw',
];

type Tab = 'form' | 'source';

function isScalar(value: AttrValue): value is string | number | boolean | null {
  return value === null || typeof value !== 'object';
}

function scalarText(value: string | number | boolean | null): string {
  if (value === null) return '';
  return typeof value === 'string' ? value : String(value);
}

/**
 * Read a form field back as an attribute value.
 *
 * Deliberately conservative, and it matches SPEC 5.3.1: only `true`/`false` are
 * booleans (no `yes`/`no` — the Norway problem), only the JSON number grammar
 * is a number, and an empty field is `null`. Everything else stays a string, so
 * a title of `2026` does not silently become an integer.
 */
function parseField(text: string): AttrValue {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null' || trimmed === '~') return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)) return Number(trimmed);
  return text;
}

export interface VisualBlockEditorProps {
  readonly block: VisualBlock;
  readonly selected: boolean;
  readonly scheme: 'light' | 'dark';
}

function VisualBlockEditorImpl({ block, selected, scheme }: VisualBlockEditorProps): ReactElement {
  const { run } = useEditorApi();
  const [tab, setTab] = useState<Tab>('form');
  const [newKey, setNewKey] = useState('');
  const [sourceDraft, setSourceDraft] = useState<string | null>(null);

  const parsed = useMemo(() => io.parseAttributes(block.header), [block.header]);
  const blockSource = useMemo(() => io.writeBlocks([block]), [block]);

  const entries = useMemo(() => Object.entries(parsed.value), [parsed.value]);

  const setAttribute = useCallback(
    (key: string, value: AttrValue | undefined) => {
      run(
        commands.updateVisualBlock(block.id, {
          header: io.setHeaderAttribute(block.header, key, value),
        }),
      );
    },
    [block.header, block.id, run],
  );

  const setData = useCallback(
    (data: string | null) => {
      run(commands.updateVisualBlock(block.id, { data }));
    },
    [block.id, run],
  );

  /*
   * The source box edits the *body* — header, separator, data — and is parsed
   * back by the same splitter the reader uses, so what the user types is what
   * the file will contain. The fence and info string are not editable here;
   * the type field owns those.
   */
  const commitSource = useCallback(
    (body: string) => {
      const split = io.splitVisualBody(body);
      run(commands.updateVisualBlock(block.id, { header: split.header, data: split.data }));
      setSourceDraft(null);
    },
    [block.id, run],
  );

  const bodySource = block.data === null ? block.header : `${block.header}\n---\n${block.data}`;

  return (
    <div className={`mdv-visual${selected ? ' is-selected' : ''}`}>
      <div className="mdv-visual__head">
        <span className="mdv-visual__badge">mdv</span>
        <label className="mdv-field mdv-field--inline">
          <span className="mdv-field__label">Type</span>
          <input
            className="mdv-field__input"
            list="mdv-block-types"
            value={block.blockType}
            spellCheck={false}
            onChange={(event) => {
              run(
                commands.updateVisualBlock(block.id, {
                  blockType: event.target.value.trim().toLowerCase(),
                }),
              );
            }}
          />
        </label>
        <datalist id="mdv-block-types">
          {KNOWN_TYPES.map((type) => (
            <option key={type} value={type} />
          ))}
        </datalist>

        <div className="mdv-tabs" role="tablist" aria-label="Block editing mode">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'form'}
            className={tab === 'form' ? 'is-active' : undefined}
            onClick={() => {
              setTab('form');
            }}
          >
            Form
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'source'}
            className={tab === 'source' ? 'is-active' : undefined}
            onClick={() => {
              setTab('source');
            }}
          >
            Source
          </button>
        </div>
      </div>

      <ChartPreview source={blockSource} scheme={scheme} blockType={block.blockType} />

      {parsed.diagnostics.length > 0 ? (
        <ul className="mdv-diagnostics" aria-label="Header problems">
          {parsed.diagnostics.map((diagnostic) => (
            <li key={`${diagnostic.code}:${String(diagnostic.line)}`}>
              <code>{diagnostic.code}</code> line {diagnostic.line}: {diagnostic.message}
            </li>
          ))}
        </ul>
      ) : null}

      {tab === 'form' ? (
        <div className="mdv-visual__form">
          <div className="mdv-visual__attrs">
            {entries.length === 0 ? <p className="mdv-visual__empty">No attributes yet.</p> : null}
            {entries.map(([key, value]) => (
              <div className="mdv-attr" key={key}>
                <span className="mdv-attr__key">{key}</span>
                {isScalar(value) ? (
                  <input
                    className="mdv-field__input"
                    aria-label={key}
                    value={scalarText(value)}
                    spellCheck={false}
                    onChange={(event) => {
                      setAttribute(key, parseField(event.target.value));
                    }}
                  />
                ) : (
                  <span className="mdv-attr__complex" title="Edit this in the Source tab">
                    {Array.isArray(value) ? 'list' : 'nested mapping'} — edit in Source
                  </span>
                )}
                <button
                  type="button"
                  className="mdv-btn mdv-btn--icon"
                  aria-label={`Remove ${key}`}
                  onClick={() => {
                    setAttribute(key, undefined);
                  }}
                >
                  ×
                </button>
              </div>
            ))}

            <form
              className="mdv-attr mdv-attr--new"
              onSubmit={(event) => {
                event.preventDefault();
                const key = newKey.trim();
                if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) return;
                setAttribute(key, null);
                setNewKey('');
              }}
            >
              <input
                className="mdv-field__input"
                placeholder="new attribute, e.g. title"
                aria-label="New attribute key"
                value={newKey}
                spellCheck={false}
                onChange={(event) => {
                  setNewKey(event.target.value);
                }}
              />
              <button type="submit" className="mdv-btn">
                Add
              </button>
            </form>
          </div>

          <div className="mdv-visual__data">
            <label className="mdv-check">
              <input
                type="checkbox"
                checked={block.data !== null}
                onChange={(event) => {
                  setData(event.target.checked ? '' : null);
                }}
              />
              <span>
                Data section{' '}
                <span className="mdv-hint">
                  (writes the <code>---</code> separator)
                </span>
              </span>
            </label>
            {block.data !== null ? (
              <textarea
                className="mdv-textarea mdv-textarea--data"
                aria-label="Data section"
                spellCheck={false}
                rows={Math.min(14, Math.max(4, block.data.split('\n').length + 1))}
                value={block.data}
                onChange={(event) => {
                  setData(event.target.value);
                }}
              />
            ) : (
              <p className="mdv-hint">
                No separator: SPEC 5.1 parses this whole body as a header. Add one to supply data
                inline.
              </p>
            )}
          </div>
        </div>
      ) : (
        <div className="mdv-visual__source">
          <textarea
            className="mdv-textarea"
            aria-label="Block body source"
            spellCheck={false}
            rows={Math.min(24, Math.max(6, bodySource.split('\n').length + 2))}
            value={sourceDraft ?? bodySource}
            onChange={(event) => {
              setSourceDraft(event.target.value);
            }}
            onBlur={(event) => {
              if (sourceDraft !== null) commitSource(event.target.value);
            }}
          />
          <p className="mdv-hint">
            Header, then <code>---</code>, then data. Applied when the box loses focus.
          </p>
        </div>
      )}
    </div>
  );
}

export const VisualBlockEditor = memo(VisualBlockEditorImpl);
