/**
 * Channel resolution and compatibility checking (SPEC 7.1, stage 3/5).
 *
 * Turns the author's encoding into bindings a chart type can consume without
 * re-deriving anything: the resolved {@link Column}, its inferred type, and the
 * title an axis or legend should show. Every mismatch the schema cannot express
 * is reported here with the code Appendix C assigns to it, and *nothing throws* —
 * a bad channel yields a diagnostic and an absent binding, and the block renders
 * its error card if the diagnostic is an error (SPEC 14.1).
 */

import type { Column, DataType, Table, Value } from '../types/data.js';
import type { Channel, ChannelName, ChannelSpec, Encoding } from '../types/encode.js';
import { channelList, hasFormConflict } from './normalize.js';
import { column, columnTitle, humanise } from './table-access.js';
import type { Reporter } from './report.js';

/** One resolved channel binding. */
export interface ChannelBinding {
  name: ChannelName;
  /** The author's channel object, after shorthand normalisation. */
  channel: Channel;
  /** The bound field, when there is one. */
  field: string | undefined;
  /** The resolved column, when the field exists in the table. */
  source: Column | undefined;
  /** The field's type, or `undefined` for a constant binding. */
  type: DataType | undefined;
  /** A constant instead of a binding, e.g. a fixed colour. */
  constant: Value | undefined;
  /** Axis/legend title: explicit, else the humanised field name. `false` suppresses. */
  title: string | false;
  /** Format: the channel's, else the column's. */
  format: string | undefined;
}

/** The outcome of resolving every declared channel. */
export interface ChannelResolution {
  /** Bindings by channel name, in declaration order. Absent channels are absent. */
  bindings: ReadonlyMap<ChannelName, ChannelBinding[]>;
  /** `false` when a required channel is missing or a type is incompatible. */
  ok: boolean;
}

/** The first binding on a channel. */
export function binding(
  resolution: ChannelResolution,
  name: ChannelName,
): ChannelBinding | undefined {
  return resolution.bindings.get(name)?.[0];
}

/** Every binding on a channel, in author order. */
export function bindings(resolution: ChannelResolution, name: ChannelName): ChannelBinding[] {
  return resolution.bindings.get(name) ?? [];
}

/**
 * Resolve an encoding against a chart type's channel declarations.
 *
 * @param specs - what the type accepts, in documentation order
 * @param encoding - the author's bindings, already normalised to object form
 * @param table - the prepared table
 * @param reporter - the diagnostic sink; the caller supplies attribute ranges
 */
export function resolveChannels(
  specs: readonly ChannelSpec[],
  encoding: Encoding,
  table: Table,
  reporter: Reporter,
): ChannelResolution {
  const bound = new Map<ChannelName, ChannelBinding[]>();
  let ok = true;

  // SPEC 7.1: `series` and a list-valued `y` describe the same split twice.
  if (hasFormConflict(encoding)) {
    ok = false;
    reporter.emit('MDV3010', {
      message: '`series` cannot be combined with a list-valued `y`',
      detail:
        'Wide form (`y: [a, b]`) and long form (`y: amount` + `series: metric`) are ' +
        'two spellings of one split (SPEC 7.1.1). Keep one.',
    });
  }

  for (const spec of specs) {
    const list = channelList(encoding, spec.name);

    if (list.length === 0) {
      if (spec.required) {
        ok = false;
        reporter.emit('MDV3000', {
          message: `Required channel \`${spec.name}\` is not bound`,
          detail: spec.doc,
        });
      }
      continue;
    }

    if (list.length > 1 && spec.list !== true) {
      ok = false;
      reporter.emit('MDV3001', {
        message: `Channel \`${spec.name}\` does not accept a list of fields`,
        detail: `${spec.doc} Bind one field, or use \`series:\` to split rows into series (SPEC 7.1.1).`,
      });
    }

    const resolved: ChannelBinding[] = [];
    for (const channel of list) {
      const entry = resolveOne(spec, channel, table, reporter);
      if (entry === undefined) {
        ok = false;
        continue;
      }
      resolved.push(entry);
    }
    if (resolved.length > 0) bound.set(spec.name, resolved);
  }

  // Channels the author bound that the type does not declare are not errors —
  // `MDV1501` was already emitted at resolve, and ignoring them here keeps a
  // plugin type's extra channels working (SPEC 15.1).
  return { bindings: bound, ok };
}

/** Resolve one binding, or `undefined` when it is unusable. */
function resolveOne(
  spec: ChannelSpec,
  channel: Channel,
  table: Table,
  reporter: Reporter,
): ChannelBinding | undefined {
  const explicitTitle = channel.title === false ? false : channel.title;

  if (channel.field === undefined) {
    if (channel.value === undefined) return undefined;
    if (spec.constant !== true) {
      reporter.emit('MDV3001', {
        message: `Channel \`${spec.name}\` does not accept a constant`,
        detail: `${spec.doc} Bind a field instead.`,
      });
      return undefined;
    }
    return {
      name: spec.name,
      channel,
      field: undefined,
      source: undefined,
      type: undefined,
      constant: channel.value,
      title: explicitTitle ?? '',
      format: channel.format,
    };
  }

  const field = channel.field;
  const source = column(table, field);
  if (source === undefined) {
    reporter.emit('MDV2111', {
      message: `Field \`${field}\` bound to \`${spec.name}\` does not exist`,
      detail:
        table.fields.length === 0
          ? 'The block has no data.'
          : `Available fields: ${table.fields.map((f) => f.name).join(', ')}.`,
    });
    return undefined;
  }

  const type = channel.type ?? source.type;
  if (spec.accepts.length > 0 && !spec.accepts.includes(type) && type !== 'unknown') {
    reporter.emit('MDV3001', {
      message: `Channel \`${spec.name}\` does not accept a \`${type}\` field (\`${field}\`)`,
      detail: `\`${spec.name}\` accepts: ${spec.accepts.join(', ')}. ${spec.doc}`,
    });
    return undefined;
  }

  return {
    name: spec.name,
    channel,
    field,
    source,
    type,
    constant: undefined,
    title: explicitTitle ?? columnTitle(source, field),
    format: channel.format ?? source.format,
  };
}

/**
 * The title for an axis on a channel: the channel's own, else the field's, else
 * the humanised channel name for a channel bound to a constant.
 */
export function axisTitleFor(
  binding_: ChannelBinding | undefined,
  name: ChannelName,
): string | false {
  if (binding_ === undefined) return humanise(name);
  return binding_.title;
}
