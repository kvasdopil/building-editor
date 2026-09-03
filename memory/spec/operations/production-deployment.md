# Production deployment

Status: Active (2026-08-28)

Normative rules for running this app in production. Read this before changing deployment
configuration, adding a server-side secret, or writing anything to disk from a route handler.

Related documents:

- [All upstream OSM traffic goes through a cached, rate-limited proxy](../../adr/0002-cached-rate-limited-osm-proxy.md): The caching and throttling policy whose persistence guarantees this environment cannot meet on its own. Read it to see which promises need a shared store before they can be claimed.
- [Submitting changes to OpenStreetMap](../domain/osm-submission.md): The OAuth configuration the deployment has to supply, and why the client id and OAuth host are server-only. Read it before changing the sign-in environment variables.

## Where it runs

The production Vercel project is `silly-goose-tech/building-editor`, connected to this repository,
serving `buildings.sillygoose.se`. DNS for `sillygoose.se` is delegated to **Google Cloud DNS**, so
the record pointing the custom domain at Vercel is changed there — with `gcloud` or in the Cloud
Console — never at the registrar.

## Configuration is environment, never a committed file

Every secret is a Vercel Production environment variable:

- `NEXT_PUBLIC_CESIUM_TOKEN` — browser-visible, so it is restricted to its one asset and to the
  production origin rather than kept secret.
- `OSM_CLIENT_ID`, `OSM_CLIENT_SECRET`, `OSM_OAUTH_BASE` — server-only OSM OAuth. The OAuth
  application's registered callback must match the domain the app is served from
  (`https://buildings.sillygoose.se/oauth/callback`); the redirect URI is built from the origin the
  user arrived on, so a deployment reached under any other host cannot complete a sign-in.
- `GEOTORGET_LOGIN`, `GEOTORGET_PASSWORD` — server-only national laser-data credentials.

**`.gitignore` is not a secret boundary for deployments.** The Vercel CLI uploads the working
directory as deployment source, so an untracked `.env` reached the build and Next.js loaded it there.
`.env` and `.env.*` therefore belong in `.vercelignore` as well. A configuration that is only correct
because a local file was _not_ uploaded is not configured — state it in the hosted environment.

## Product analytics is anonymous and aggregate

Vercel Web Analytics measures page visits and a deliberately small editing funnel. The deployment
must have Web Analytics enabled in the Vercel project before a deployment containing the analytics
component can report data. Page views are available on every Vercel plan; the custom funnel events
require a Pro or Enterprise plan.

The URL fragment is removed before every page-view or custom event is sent because the fragment can
contain a selected OSM feature id. Custom event properties must never include an OSM id, coordinate,
account name, changeset id, changeset comment, source field, or other user-entered text.

The supported client events are one-per-page-visit signals for selecting a building, having pending
changes, Photos, LiDAR, and Google 3D, plus a count each time submission review is opened. A LiDAR
query completion is counted once per selected building per page visit, but sends only its categorical
result, survey name, and a coarse point-count bucket. The building id is used only in browser memory
to suppress duplicate events and is not sent.

OSM upload attempts, successes, and failures are emitted by the changeset route after authentication
and validation. They carry only the development-or-production target, aggregate element count, and,
for failures, the HTTP status and error category. Server-side success is the authoritative submission
metric; a review opening is intent, not a completed submission.

## LOD1 is excluded from production

Stockholm LOD1 is development-only until its metadata states explicit redistribution and
OSM-compatible reuse terms. `NODE_ENV=production` removes the toggle and advice, prevents all client
requests, and makes `/api/lod1/tile/...` return 404. No build includes LOD1 in the default changeset
source. `/data/lod1/` is also in `.vercelignore`, so a CLI deployment cannot accidentally upload a
local import even though the directory is already gitignored.

## The filesystem is not storage

The deployed project directory is not persistently writable, and instances are ephemeral and
horizontally scaled. Every disk write from a route handler is therefore best-effort: it is attempted,
and a failure leaves the in-memory layer to stand on its own rather than failing a request that had
already succeeded upstream.

What that costs is real and must not be papered over. The per-instance memory cache does not deliver
ADR 0002's persistent store or its global hard budget across instances: each instance counts its own
requests and remembers its own tiles. Those guarantees can only be claimed again behind a shared
durable cache and a distributed limiter.
