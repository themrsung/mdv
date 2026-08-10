/**
 * Image alignment is a *preview* setting.
 *
 * The engine's `ImageBlock` is `{src, alt, title, width, height}` and its
 * writer emits `![alt](src "title"){width=… height=…}`. There is no place in
 * that syntax for an alignment, so the editor cannot save one. It is offered
 * anyway — laying an image out is a real need while writing — but it is
 * labelled, kept out of the document model, and reported upstream rather than
 * being smuggled into `title` or into a stray attribute the writer would drop.
 */
export type ImageAlign = 'left' | 'center' | 'right';
