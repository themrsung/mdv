/**
 * The slash menu.
 *
 * Focus stays in the document the whole time — the menu is a `listbox` the
 * caret's block owns through `aria-activedescendant`, not a popup that steals
 * the caret. That is what lets the user keep typing to filter, and it is the
 * only arrangement in which the composition state of an input method survives
 * the menu opening.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { SlashItem } from './slash-items.js';

export interface SlashMenuProps {
  /** Caret rectangle in viewport coordinates, or `null` when unknown. */
  readonly anchor: DOMRect | null;
  readonly query: string;
  readonly items: readonly SlashItem[];
  readonly onChoose: (item: SlashItem) => void;
  readonly onDismiss: () => void;
  /**
   * Hands the surface a key handler. Arrow keys and Enter arrive at the
   * document, not here, because the document still has focus.
   */
  readonly registerKeyHandler: (handler: ((key: string, shift: boolean) => boolean) | null) => void;
}

export function SlashMenu(props: SlashMenuProps): ReactElement | null {
  const { anchor, query, items, onChoose, onDismiss, registerKeyHandler } = props;
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  // A new query is a new list; keeping the old index would highlight whatever
  // happened to land in that slot.
  useEffect(() => {
    setIndex(0);
  }, [query]);

  useEffect(() => {
    const handler = (key: string, shift: boolean): boolean => {
      if (items.length === 0) return false;
      if (key === 'ArrowDown' || (key === 'Tab' && !shift)) {
        setIndex((current) => (current + 1) % items.length);
        return true;
      }
      if (key === 'ArrowUp' || (key === 'Tab' && shift)) {
        setIndex((current) => (current - 1 + items.length) % items.length);
        return true;
      }
      if (key === 'Enter') {
        setIndex((current) => {
          const chosen = items[current];
          if (chosen !== undefined) onChoose(chosen);
          return current;
        });
        return true;
      }
      return false;
    };
    registerKeyHandler(handler);
    return () => {
      registerKeyHandler(null);
    };
  }, [items, onChoose, registerKeyHandler]);

  useLayoutEffect(() => {
    const active = listRef.current?.querySelector('[aria-selected="true"]');
    if (active instanceof HTMLElement) active.scrollIntoView({ block: 'nearest' });
  }, [index]);

  if (anchor === null) return null;

  // Flip above the caret when there is not room below it.
  const belowSpace = window.innerHeight - anchor.bottom;
  const above = belowSpace < 260 && anchor.top > 260;
  const style = {
    left: `${String(Math.round(Math.min(anchor.left, window.innerWidth - 320)))}px`,
    top: above ? undefined : `${String(Math.round(anchor.bottom + 6))}px`,
    bottom: above ? `${String(Math.round(window.innerHeight - anchor.top + 6))}px` : undefined,
  };

  let lastGroup: string | null = null;

  return (
    <div className="mdv-slash" style={style} role="presentation">
      {items.length === 0 ? (
        <p className="mdv-slash__empty">
          No block matches “{query}”. <button type="button" className="mdv-linkbtn" onClick={onDismiss}>Dismiss</button>
        </p>
      ) : (
        <ul className="mdv-slash__list" role="listbox" aria-label="Insert block" ref={listRef}>
          {items.map((item, position) => {
            const header = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <li key={item.id} className="mdv-slash__entry">
                {header === null ? null : <div className="mdv-slash__group">{header}</div>}
                <div
                  id={`mdv-slash-${item.id}`}
                  role="option"
                  aria-selected={position === index}
                  className={`mdv-slash__item${position === index ? ' is-active' : ''}`}
                  onPointerDown={(event) => {
                    // Keep the caret: a mousedown that moved focus would close
                    // the menu before the click landed.
                    event.preventDefault();
                  }}
                  onClick={() => {
                    onChoose(item);
                  }}
                  onPointerEnter={() => {
                    setIndex(position);
                  }}
                >
                  <span className="mdv-slash__label">{item.label}</span>
                  <span className="mdv-slash__hint">{item.hint}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
