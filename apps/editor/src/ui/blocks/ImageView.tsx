/**
 * Images.
 *
 * Selecting one opens its inspector: alt text, an explicit pixel width, and the
 * weight the image adds to the file. Resizing is a drag on the right edge that
 * commits a `width` on release, so an accidental nudge is one undo step rather
 * than forty.
 *
 * **Alignment is display-only, and says so.** The engine's `ImageBlock` carries
 * `src`, `alt`, `title`, `width` and `height` and nothing else, and its writer
 * emits `![alt](src "title"){width=… height=…}` — there is no spelling of
 * alignment that would survive a round trip through `.mdv`. Rather than
 * pretend, the control is labelled as a preview setting. See NEEDS FROM OTHERS.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { ImageBlock } from '../../engine/index.js';
import { commands, images as engineImages } from '../../engine/index.js';
import { base64Bytes, formatBytes } from '../input/images.js';
import { useEditorApi } from '../state/store.js';
import type { ImageAlign } from './image-align.js';

export interface ImageViewProps {
  readonly block: ImageBlock;
  readonly selected: boolean;
  readonly align: ImageAlign;
  readonly onAlign: (blockId: string, align: ImageAlign) => void;
}

function ImageViewImpl({ block, selected, align, onAlign }: ImageViewProps): ReactElement {
  const { run } = useEditorApi();
  const [draftWidth, setDraftWidth] = useState<number | null>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);

  const embedded = engineImages.isEmbedded(block.src);
  const weight = embedded ? base64Bytes(block.src) : 0;
  const shownWidth = draftWidth ?? block.width;

  const commitWidth = useCallback(
    (width: number | null) => {
      run(commands.updateImage(block.id, { width }));
    },
    [block.id, run],
  );

  const onResizeStart = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const host = wrapper.current;
      if (host === null) return;
      const left = host.getBoundingClientRect().left;
      const maximum = host.parentElement?.getBoundingClientRect().width ?? 2048;
      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);

      const move = (moveEvent: PointerEvent): void => {
        const next = Math.round(Math.min(Math.max(moveEvent.clientX - left, 32), maximum));
        setDraftWidth(next);
      };
      const finish = (upEvent: PointerEvent): void => {
        target.releasePointerCapture?.(upEvent.pointerId);
        target.removeEventListener('pointermove', move);
        target.removeEventListener('pointerup', finish);
        target.removeEventListener('pointercancel', finish);
        setDraftWidth((current) => {
          if (current !== null) commitWidth(current);
          return null;
        });
      };
      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', finish);
      target.addEventListener('pointercancel', finish);
    },
    [commitWidth],
  );

  useEffect(() => {
    if (!selected) setDraftWidth(null);
  }, [selected]);

  const failed = block.src.trim() === '';

  return (
    <div className={`mdv-image mdv-image--${align}`} ref={wrapper}>
      <figure className="mdv-image__frame" style={shownWidth === null ? undefined : { width: `${String(shownWidth)}px` }}>
        {failed ? (
          <div className="mdv-image__broken">Image has no source.</div>
        ) : (
          <img
            className="mdv-image__img"
            src={block.src}
            alt={block.alt}
            {...(block.title === null ? {} : { title: block.title })}
            draggable={false}
            onLoad={(event) => {
              const element = event.currentTarget;
              setNatural({ width: element.naturalWidth, height: element.naturalHeight });
            }}
          />
        )}
        {block.alt === '' ? (
          <figcaption className="mdv-image__warn">
            No alt text — add one so this image is described to screen readers.
          </figcaption>
        ) : null}
        {selected ? (
          <button
            type="button"
            className="mdv-image__resize"
            aria-label="Resize image"
            onPointerDown={onResizeStart}
          />
        ) : null}
      </figure>

      {selected ? (
        <div className="mdv-inspector" contentEditable={false}>
          <div className="mdv-inspector__row">
            <label className="mdv-field">
              <span className="mdv-field__label">Alt text</span>
              <input
                className="mdv-field__input"
                type="text"
                value={block.alt}
                placeholder="What does this image show?"
                onChange={(event) => {
                  run(commands.updateImage(block.id, { alt: event.target.value }));
                }}
              />
            </label>
          </div>

          <div className="mdv-inspector__row">
            <label className="mdv-field mdv-field--narrow">
              <span className="mdv-field__label">Width</span>
              <input
                className="mdv-field__input"
                type="number"
                min={16}
                step={8}
                value={shownWidth ?? ''}
                placeholder={natural === null ? 'auto' : String(natural.width)}
                onChange={(event) => {
                  const value = event.target.value.trim();
                  commitWidth(value === '' ? null : Math.max(16, Number.parseInt(value, 10) || 16));
                }}
              />
            </label>
            <button
              type="button"
              className="mdv-btn"
              onClick={() => {
                commitWidth(null);
              }}
              disabled={block.width === null}
            >
              Reset size
            </button>
          </div>

          <div className="mdv-inspector__row">
            <fieldset className="mdv-field mdv-field--group">
              <legend className="mdv-field__label">
                Alignment <span className="mdv-badge">preview only</span>
              </legend>
              <div className="mdv-segmented" role="group">
                {(['left', 'center', 'right'] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={align === option ? 'is-active' : undefined}
                    aria-pressed={align === option}
                    onClick={() => {
                      onAlign(block.id, option);
                    }}
                  >
                    {option[0]?.toUpperCase()}
                    {option.slice(1)}
                  </button>
                ))}
              </div>
            </fieldset>
          </div>

          <p className="mdv-inspector__note">
            {embedded
              ? `Embedded as base64 — about ${formatBytes(weight)} of this document.`
              : 'Linked from an external URL; nothing is embedded.'}
            {' Alignment is not part of the .mdv image syntax, so it is not saved.'}
          </p>
        </div>
      ) : null}
    </div>
  );
}

export const ImageView = memo(ImageViewImpl);
