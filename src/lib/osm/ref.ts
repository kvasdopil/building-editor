/**
 * References to OSM elements as text: what the URL hash carries, and what
 * people have to hand when they want to look a building up.
 */

export interface OsmRef {
  type: "way" | "relation";
  id: string;
}

/**
 * Parse an element reference. Accepts a "#way/123" hash, a bare "way/123",
 * "w123", "r123", and pasted openstreetmap.org URLs. Nodes are not buildings,
 * and a drawn element's negative id (`way/-1`) is not upstream yet, so both fail.
 */
export function parseOsmRef(input: string): OsmRef | null {
  const text = input.trim().toLowerCase();
  // Longest alternatives first, and allow the "#" people actually type.
  const match = text.match(/(?:^|[#/])(way|relation|w|r)[/ ]?(\d+)\s*$/);
  if (!match) return null;
  return { type: match[1].startsWith("r") ? "relation" : "way", id: match[2] };
}

/** The canonical `way/123` form of an element id, or null when it is not one. */
export function osmRefId(elementId: string): string | null {
  const ref = parseOsmRef(elementId);
  return ref ? `${ref.type}/${ref.id}` : null;
}

/**
 * The id for an element that has been drawn but not uploaded. OSM has no id for
 * it until a changeset assigns one, so it carries a negative placeholder — the
 * same convention JOSM ("way -1") and iD ("w-1") use internally, and the exact
 * id the changeset sends in `<way id="-1">`.
 *
 * Keeping the `type/id` form means one grammar everywhere: the type says which
 * element the upload creates, and `parseOsmRef` still refuses it, because there
 * is nothing upstream to look up or link to.
 */
export function drawnRef(type: "way" | "relation", counter: number): string {
  return `${type}/-${counter}`;
}

/** The negative placeholder id in a drawn element's ref, or null for a real one. */
export function drawnId(elementId: string): number | null {
  const match = elementId.match(/^(?:way|relation)\/(-\d+)$/);
  return match ? Number(match[1]) : null;
}
