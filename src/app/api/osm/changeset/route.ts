import { NextResponse } from "next/server";
import { track } from "@vercel/analytics/server";
import { readJsonBody } from "@/lib/json-request";
import { changesetTags, type ChangesetPlan } from "@/lib/osm/changeset";
import { isProductionHost, OAUTH_BASE, readSession } from "@/lib/osm/oauth";
import { UploadError, uploadChangeset } from "@/lib/osm/upload";

/**
 * Sends one reviewed changeset. The browser posts the plan it reviewed, never a
 * token: the token is read from the httpOnly cookie here (ADR 0002).
 */
export async function POST(request: Request) {
  const session = await readSession();
  if (!session) {
    return NextResponse.json({ error: "Not signed in to OpenStreetMap" }, { status: 401 });
  }

  const body = await readJsonBody<{ plan?: ChangesetPlan; comment?: unknown; source?: unknown }>(
    request,
  );
  if (!body) return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  const plan = body.plan;
  const comment = typeof body.comment === "string" ? body.comment : "";
  const source = typeof body.source === "string" ? body.source : undefined;
  if (!plan || !Array.isArray(plan.ways) || !Array.isArray(plan.nodes)) {
    return NextResponse.json({ error: "Expected a changeset plan" }, { status: 400 });
  }
  if (plan.nodes.length + plan.ways.length + plan.relations.length === 0) {
    return NextResponse.json({ error: "The changeset is empty" }, { status: 400 });
  }
  if (comment.trim().length === 0) {
    return NextResponse.json({ error: "A changeset needs a comment" }, { status: 400 });
  }

  const analytics = {
    target: isProductionHost(new URL(OAUTH_BASE).host) ? "production" : "development",
    elements: plan.nodes.length + plan.ways.length + plan.relations.length,
  };

  try {
    await track("OSM Submission Attempted", analytics, { request }).catch(() => undefined);
    const result = await uploadChangeset({
      accessToken: session.accessToken,
      plan,
      tags: changesetTags({ comment, source }),
    });
    await track("OSM Submission Succeeded", analytics, { request }).catch(() => undefined);
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof UploadError) {
      await track(
        "OSM Submission Failed",
        { ...analytics, kind: error.kind, status: error.status },
        { request },
      ).catch(() => undefined);
      return NextResponse.json(
        { error: error.message, kind: error.kind },
        { status: error.status },
      );
    }
    await track(
      "OSM Submission Failed",
      { ...analytics, kind: "unknown", status: 502 },
      { request },
    ).catch(() => undefined);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload failed" },
      { status: 502 },
    );
  }
}
