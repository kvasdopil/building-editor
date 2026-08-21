# Submitting changes to OpenStreetMap

Status: Active (2026-08-19)

Normative rules for turning the local pending changes into an OSM changeset, and for the checks that must pass before it is uploaded. Read this before changing `src/lib/osm/changeset.ts`, `src/lib/osm/nodes.ts` or `src/lib/osm/validate.ts`.

Related documents:

- [Building Explorer domain spec](building-explorer.md): The editing behavior that produces these pending changes — tag edits, Cut hole, Slice, and the height rules the checks reuse. Read it first.
- [EP-001 Edit buildings and submit to OSM](../../plans/epics/EP-001-osm-editing/index.md): Delivery sequence. Read it to see which slice owns sign-in and the upload itself.
- [Live OSM data for editing](../../adr/0001-live-osm-data-for-editing.md): Why edit targets come from the OSM API and carry element type, id and version. Node identity below depends on it.

## Scope

The flow runs end to end: review, sign in, upload. What is _not_ automatic is the decision to write —
the Upload button is gated on a signed-in account, zero errors, a comment, and, for a production host,
an explicit setting plus a confirmation.

## What a changeset must carry

### Node identity

Every vertex of an edited or created footprint is resolved against the nodes already loaded, and reused when it matches one:

- **Exact position match always reuses.** OSM stores coordinates as fixed-point integers scaled by 1e7, so two vertices that round to the same 7 decimals are the same place and must be the same node.
- **A near miss (within 3 cm) reuses only within the edit's own building group** — the outline and its parts. Absorbing a vertex into an unrelated building's node ties the two together for every future edit, so that stays deliberate.
- **Two new vertices at one position collapse into one node.** Without this the two parts either side of a slice are not joined, only coincident.
- The node index is built from loaded building and part features only, so a vertex can never be glued onto a highway or fence node — those are never parsed.

The result: slicing a building in two adds two nodes, not eight, and an unchanged wall keeps every node id it had.

### Moving a node

**A dragged corner moves its node; it never replaces it.** Position alone cannot tell a moved vertex
from a new one, so each drag is recorded on the geometry override as a `from`/`to` pair, and the
upload turns that into a `modify` on the node itself.

This is the only way a drag can keep the promise the shared-vertex expansion makes. Replacing the
node creates one at the new corner and leaves the old one behind: orphaned in OSM, stripped of any
tags it carried, and still holding every way this editor cannot see — a fence, a path, an outline
outside the loaded tiles — at the corner the mapper believed they had moved. Moving the node carries
all of them, loaded or not. It is also what JOSM does, and why OSM node history is worth anything.

- **A `modify` replaces the element**, so it carries the node's version — or the API cannot reject a
  conflict — and the node's own tags — or the upload deletes them. Both are parsed out of the tile
  and indexed alongside the node (`osm/nodes.ts`). A node whose version is not in the loaded data is
  never moved: that is a blocking `node-version-unknown`, not a guess.
- **Dragging the same node twice is one move**, from where OSM has it, and dragging it back to where
  it started is no move at all.
- **A node dragged exactly onto another node** would stack two in one place. Merging nodes is not
  supported, so that is a blocking `node-merge-unsupported`.
- **A node that has been dragged away is no longer at its old position.** Another vertex landing on
  the vacated spot resolves as a new node, not as the one that left.
- **Ways an upload would rewrite identically are left out.** Moving a node changes the node, not the
  ways listing it, so a drag that only moved corners sends the node and nothing else. Resending those
  ways would bump their versions for nothing and invite a conflict over elements we are not
  changing — the same rule tag-only edits already follow. Their review entries stay, because the
  buildings really are being reshaped, through their nodes.

Direct node dragging expands one exact-coordinate vertex into every loaded building and part that
uses it. Each affected existing entity receives a geometry override at the same new coordinate, and
each records the same move; a drawn part updates its own geometry and records nothing, having no
upstream node to move. The scope is deliberately the loaded building/part collection—the editor
cannot update an owner whose geometry it has not read—but moving the node rather than replacing it
is what makes that scope a display limit rather than a data one. Reverting one affected building's
override therefore leaves the corner moved for the others and for that building too, since it is one
node; the map keeps showing the reverted building unmoved until its tile is reloaded.

MapLibre's rendered point coordinate is only a hit-test result, not node identity: projection can
round it away from the exact source coordinate. A draggable handle therefore carries polygon, ring
and vertex indexes and resolves those back into the selected source geometry before finding shared
owners. Comparing the rendered coordinate directly makes an apparently active drag a no-op because
no exact vertex matches it.

### Node insertion into shared walls

A slice ends on a wall, so its end vertices lie on a segment of the outline (or of a sibling part) without being nodes of it. Those vertices are inserted into the host way at the right position, ordered along the segment. Unjoined, the part boundary crosses the outline with nothing shared — what JOSM reports as crossing building ways, and what comes apart the first time somebody drags the wall.

A host that is a relation cannot take the node, because assembled ring geometry does not say which member way to change. That is reported as a warning rather than uploaded as a wall that only looks shared.

### Ids for drawn elements

An element drawn here has no OSM id until an upload assigns one, so it carries a **negative
placeholder** in the app's ordinary `type/id` form: `way/-1`, `way/-2`. That is the same convention
JOSM ("way -1") and iD ("w-1") use internally, and the changeset sends exactly that number —
`<way id="-1">` — so the id in the review dialog and the id in the `osmChange` are one and the same.
`parseOsmRef` still refuses it, because there is nothing upstream to fetch or link to, and a negative
id is therefore also the test for "was this drawn here".

The review dialog says so where it lists elements, because a negative id in a list of things about to
be written reads like a bug otherwise.

The type in the ref names the way the user drew. If holes make that way upload as a multipolygon, the
relation takes the same placeholder number and the member ways get their own; placeholder ids are
scoped per element type in an `osmChange`, so `relation -1` and `way -1` do not collide.

### Elements that are not there

`drawn-element-missing` and `element-not-loaded` are separate errors because the fixes differ. A tag
override on a negative id whose geometry is gone can only be reverted and drawn again; an override
on a real element whose tile is not loaded just needs the map panned back, so the current version can
be read. Both halves of the pending change set persist (see the [building explorer
spec](building-explorer.md)), so the first should now only happen where storage is unavailable.

### Versions

Every modify carries the `version` read from the API, so a stale edit is rejected as a conflict instead of silently overwriting newer data. An element with no known version is an error, not a guess.

### Element shape

A way holds exactly one ring, so anything with holes becomes a `type=multipolygon` relation:

- Cutting a hole in an existing way **converts** it: the way stays as the untagged `outer` member and the tags move to the new relation, which is what the multipolygon wiki prescribes ("outer ways must be left untagged") and what JOSM's _create multipolygon_ does.
- A created part with holes becomes new ways plus a new relation.
- Changing the geometry of an element that is **already** a relation is not supported: ring geometry is assembled across member ways, so we cannot tell which member changed. It is an error, not a best guess.

### Tags

- A pending value equal to what OSM already has is dropped from the changeset, so no version is bumped for nothing.
- An override with an empty value deletes the tag, which is how OSM expresses a tag deletion.
- Values are trimmed before comparison and upload.

### No winding rule

OSM has no ring-direction convention for buildings — "the direction of the ways does not matter" — and JOSM only checks direction for `natural=coastline` and `natural=land`. Ring order is therefore never rewritten on upload. Internally, geometry follows GeoJSON RFC 7946 (outer counter-clockwise, holes clockwise) because turf, MapLibre and the 3D extrusion read it; `signedRingArea`, `orientRing`, `closeRing` and `openRing` in `src/lib/geometry.ts` are the single implementation.

### No coordinate grid beyond OSM's own

The only grid is OSM's 1e-7 degree (~1.1 cm) fixed point, and rounding to it is lossless. Nothing snaps existing nodes to a coarser grid: that would _move_ them, and adjacent buildings share nodes, so a move meant for one building would drag its neighbours.

## Signing in

Sign-in is OAuth 2.0 with PKCE against the **development** API, because writes are proven there before
production (EP-001 FT-07). The submit dialog is where it lives: the signed-in account name with a
**Log out** button, or a **Log in with OpenStreetMap** button when signed out. The host is named next
to the account, so a dev-server identity is never mistaken for a production one.

The browser never holds an access token. It starts the flow, receives an authorization code, and hands
that code to this app's own route, which exchanges it and stores the token in an httpOnly cookie —
ADR 0002 forbids the browser from talking to an upstream API, and a token it cannot read is a token it
cannot leak. Consent itself is the one upstream navigation that cannot be proxied: it has to happen on
the OSM site, in the user's own session.

Rules that follow from that:

- **The session is confirmed upstream, not trusted from the cookie.** A token the user revoked on
  their OSM account page must read as signed out here, so `/api/osm/session` asks OSM who the token
  belongs to.
- **Signing out revokes the token** before dropping the cookie. A sign-out that leaves a live token
  upstream is not a sign-out.
- **`state` is checked on the way back**, and the PKCE verifier is consumed once. A response that did
  not start in this session is refused, not exchanged.
- **Sign-in happens in a popup**, so the map, the selection and the pending changes survive it. A
  blocked popup falls back to a full-page redirect, which is safe only because pending changes
  persist — see the [building explorer spec](building-explorer.md).
- **The only scopes requested are `read_prefs` and `write_api`.** There is no per-element scope:
  `write_api` ("Modify the map") covers nodes, ways and relations through a changeset. `write_api` is
  requested at sign-in, while nothing writes yet, so uploading later does not send everyone through a
  second consent screen. `write_redactions` ("Redact map data") is a moderator scope for editing
  element history and must never be requested.
- **The dev instance and production are separate installations** with separate accounts and separate
  application registries, so an application registered on one is an _unknown client_ on the other —
  `invalid_client` at the token endpoint, not a secret problem. `OSM_OAUTH_BASE` chooses which, and the
  account row names the host, in amber when it is the real map.
- **A confidential application is supported and preferred where available.** The exchange runs on the
  server, so `OSM_CLIENT_SECRET` can be held properly; PKCE is sent either way, because it proves the
  browser that finished the flow started it, which a secret does not.
- **The client id and OAuth host are server-only configuration** (`OSM_CLIENT_ID`, `OSM_OAUTH_BASE`),
  read in one module and served to the browser by `/api/osm/session`. `NEXT_PUBLIC_` would inline them
  at build time, so a client id could only change by rebuilding and one build could not serve both dev
  and production. A public PKCE client id is not a secret — it travels in the consent URL — so this is
  about configuration, not concealment.
- **Auth requests skip the tile limiter.** Its token bucket rations shared map data; a sign-in queued
  behind thirty pending tiles would be a bug. They still identify the client, as the policy requires.
- **The redirect URI is the origin in use, plus `/oauth/callback`.** OSM forces https on redirect URIs
  and exempts only `127.0.0.1` and `::1` — not the name `localhost` — so local development registers
  and browses the loopback IP. The dialog says so when it is opened on `localhost`. Whether the session
  cookie is marked `secure` follows the incoming request's protocol, not the build environment, or a
  locally started production build over http would drop the cookie and fail sign-in silently.
- **No client id, no button.** Without `OSM_CLIENT_ID` the dialog says what to register
  and where, rather than offering a control that cannot work.

## Sending the changeset

Three upstream calls, all server-side because the token is in an httpOnly cookie: create the changeset,
upload the `osmChange` into it, close it. A diff upload is atomic — everything lands or nothing does —
so there is no partial state to reconcile.

- **The document is rendered on the server from the reviewed plan**, not posted as text by the browser,
  so the review and the upload come from the same function. The only difference is the changeset id,
  which does not exist until the create call returns.
- **The changeset is closed whether the upload succeeded or not.** One left open holds for an hour and
  would collect the next edit made from anywhere.
- **Failures are reported in OSM's own words.** A version conflict answers with e.g. "Version mismatch:
  Provided 3, server had: 4 of Way 123" — nothing we could write is more useful than that.
- **`diffResult` is read for the placeholder → real id mapping** and shown, but local state is not
  rewritten from it: the affected tiles are refetched past every cache instead (`?fresh=1`), so the map
  shows what OSM now holds rather than our guess at it.
- **Pending changes are dropped once the changeset lands.** Keeping them would re-propose an edit that
  has already been made, and a drawn part would keep its placeholder id forever.
- **Writing to the real OSM needs its own setting.** `OSM_ALLOW_PRODUCTION_WRITES=true` is required when
  the host is production; pointing `OSM_OAUTH_BASE` at the real map is deliberately not enough. An
  accidental upload cannot be taken back, only reverted in a second changeset that stays in the
  history. The submit dialog also asks for confirmation before writing to a production host, naming the
  account, the host and the element count.

## Pre-upload checks

Errors block the upload; warnings are for a reviewer to accept or fix. Where an upstream rule exists we follow it rather than inventing one — numeric formats from JOSM's `numeric.mapcss`, geometry rules from its `geometry.mapcss` and validation tests, coverage from Simple 3D Buildings.

### What the checks are allowed to complain about

Only what the changeset writes. Real OSM buildings carry tagging and geometry from years of other
mappers, and an element we merely resend byte for byte — the outline of a sliced building, say — must
not turn into a lecture about somebody else's work, still less block an upload:

- **Tag checks run on the keys this changeset changes.** An element with no tag change gets no tag
  checks at all. The cross-tag consistency rules (`min_height` against `height`, `roof:height`,
  `building:min_level` against `building:levels`) read the element's full effective state, because
  that state is what the upload produces, but they only run when we are writing its tags.
- **Ring checks run on the element the change is about**, never on its neighbours or its untouched
  siblings.
- **`part-outside-outline` is an error for a part we write and a warning for one we inherit.**
- Uppercase in a key is not suspicious: `ref:SE:raa` and `name:en` are ordinary OSM. Whitespace is.

### Errors

| check                                                                               | rule                                                                                                                                                                           |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `changeset-empty`                                                                   | Nothing to upload, including the case where every pending change already matches OSM.                                                                                          |
| `changeset-comment-missing`                                                         | A changeset needs a comment saying what changed.                                                                                                                               |
| `changeset-too-large`                                                               | Over the API's 10 000 elements per changeset; it has to be split.                                                                                                              |
| `way-too-many-nodes`                                                                | Over the API's 2 000 nodes per way.                                                                                                                                            |
| `node-version-unknown`                                                              | A dragged corner's node has no version in the loaded data, so moving it could overwrite a newer edit.                                                                          |
| `node-merge-unsupported`                                                            | A corner was dragged exactly onto another node, which would stack two in one place.                                                                                            |
| `node-move-conflict`                                                                | The pending changes drag one node to two different places.                                                                                                                     |
| `way-not-closed`                                                                    | An area way must be closed and have at least three corners (JOSM `UnclosedWays`).                                                                                              |
| `duplicated-way-nodes`                                                              | The same node listed twice in a row (JOSM `DuplicatedWayNodes`).                                                                                                               |
| `self-touching-way`                                                                 | The same node visited twice, so the outline touches itself.                                                                                                                    |
| `self-intersecting-way`                                                             | A ring that crosses itself (JOSM `SelfIntersectingWay`).                                                                                                                       |
| `degenerate-ring`                                                                   | A ring with fewer than three corners, before or after node resolution.                                                                                                         |
| `part-outside-outline`                                                              | A `building:part` this changeset writes reaching outside its outline (JOSM: `area[building] ⧉ area[building:part]`, "Overlapping buildings"). Pre-existing parts warn instead. |
| `multipolygon-without-outer`, `multipolygon-member-role`                            | A created multipolygon must have an `outer` member and only `outer`/`inner` roles.                                                                                             |
| `element-not-loaded`, `missing-version`, `missing-node-list`, `missing-member-list` | The identity an upload needs is absent. Resending a relation without its members would empty it.                                                                               |
| `relation-geometry-unsupported`                                                     | Geometry change on a multipolygon relation (see above).                                                                                                                        |
| `negative-levels`, `levels-format`                                                  | `building:levels` must be a non-negative count, halves allowed: `/^(([0-9]\|[1-9][0-9]*)(\.5)?)$/` (JOSM).                                                                     |
| `length-format`                                                                     | `height`, `min_height`, `roof:height` must parse as a length.                                                                                                                  |
| `height-not-positive`                                                               | A height must be above zero.                                                                                                                                                   |
| `min-height-above-height`, `roof-height-above-height`                               | A part cannot start above its top, and a roof cannot be taller than the whole building.                                                                                        |
| `min-level-above-levels`                                                            | `building:min_level` cannot skip every level of `building:levels`.                                                                                                             |

### Warnings

| check                                        | rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outline-not-covered`                        | Ground-level parts leave more than 2% and 2 m² of the outline uncovered. Simple 3D Buildings: "the entire building outline should be filled with `building:part` areas". Parts are **unioned**, not summed — `partsCoverage` in `src/lib/parts.ts` sums, which is right for its rendering threshold and wrong as a check.                                                                                                                                                                                           |
| `overlapping-volumes`                        | Two parts overlap in plan **and** in their `[min_height, height]` range. 2D overlap is explicitly allowed; overlapping 3D volumes are what the wiki says to avoid.                                                                                                                                                                                                                                                                                                                                                  |
| `part-above-building`                        | A part reaching above the outline's height; the outline should carry the overall height.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `node-not-joined-to-host`                    | New nodes lying on a relation outline, which cannot take them.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `disconnected-parts`                         | A part, or a small group of them, touching no other part of the building. Simple 3D Buildings allows parts to "be disjunct, depending on the building", so this is a heuristic: a wing across a courtyard is legitimate, a part sitting on its own is more often misplaced. Groups holding more than half the parts are treated as the main structure and not named. Adjacency is geometric — overlap, or a wall within 5 cm of another wall — so parts that abut without being glued still count as one structure. |
| `tiny-part`                                  | A part under 1 m², usually a slice artefact.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `too-large-building`                         | Footprint over 920 000 m² (JOSM's "Too large building").                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `implausible-height`                         | Over 300 m.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `decimal-separator`, `unusual-length-format` | JOSM: use `.` not `,`, and the abbreviation `m` with a space before it.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `deprecated-key`                             | `min_levels`, `building:min_levels`, `levels`, `building:height`.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `suspicious-key`, `value-whitespace`         | Uppercase or spaces in a key; padding in a value.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

### Deliberately not checked

- Ring winding (see above).
- Conflicts against current OSM state. A version comparison only means something at upload time, when the API answers 409; the plan carries the versions that make that possible.

## Review before upload

The changeset comment is required: at least a few characters, checked by one rule that both the field
and the blocking check use, so they cannot disagree. That rule is evaluated **apart from the rest of
the checks**, because it is the only finding that changes while somebody types: the geometry pass walks
every part of every touched building through boolean operations, and folding the comment into it made
each keystroke pay for that — measured at 12 ms per keystroke on a nine-part building, before any
rendering. A default is offered from the plan itself, but it
can be cleared, and then nothing may be uploaded.

What the review is built from has to follow the **loaded data**, not only the pending edits. Raw tiles
arrive asynchronously and long after a reload restores the edits, so a plan derived only from edit
changes is assembled against an empty map — and reports every restored edit as an element that is not
loaded.

The submit dialog is the whole contract with the user before anything leaves the browser:

- a changeset comment, defaulted from the plan itself, and an optional `source` that starts as
  `Lantmateriet Laserdata, skog; Stockholm LOD1` — the two height datasets this editor works from —
  and is editable, with an empty field leaving the tag out entirely;
- every error and warning, each linking to the elements it is about;
- per-element rows: action, target, version, tag diffs, how many nodes were reused versus created, which elements a node is now shared with, and every structural consequence in words (the multipolygon conversion, the nodes inserted into a wall);
- the exact `osmChange` document, copyable and downloadable as `.osc` so the same edit can be opened and validated in JOSM.
