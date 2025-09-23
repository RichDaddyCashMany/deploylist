import { NextRequest, NextResponse } from "next/server";
import { addDeployRecord, getLatestDeployRecords } from "@/lib/db";
import type { CreateDeployPayload } from "@/lib/types";

function bad(msg: string, code = 400) {
  return NextResponse.json({ error: msg }, { status: code });
}

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const limit = Math.max(1, Math.min(50, Number(searchParams.get("limit")) || 20));
  // 支持 ?projectName=a&projectName=b 或 ?projects=a,b
  const multi = searchParams.getAll("projectName");
  const csv = searchParams.get("projects");
  const projects = multi.length > 0 ? multi : csv ? csv.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const data = await getLatestDeployRecords(limit, projects);
  const res = NextResponse.json({ data });
  res.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.headers.set("Pragma", "no-cache");
  res.headers.set("Expires", "0");
  return res;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Partial<CreateDeployPayload>;
    const required = ["title", "projectName", "operator", "environment", "branch", "commit", "status"] as const;
    for (const key of required) {
      if (!body[key]) return bad(`missing field: ${key}`);
    }

    const payload: CreateDeployPayload = {
      title: String(body.title),
      projectName: String(body.projectName),
      operator: String(body.operator),
      environment: String(body.environment),
      branch: String(body.branch),
      commit: String(body.commit),
      note: body.note ? String(body.note) : undefined,
      deployedAt: body.deployedAt ? new Date(body.deployedAt).toISOString() : undefined,
      status: body.status as CreateDeployPayload["status"],
    };

    const saved = await addDeployRecord(payload);
    const res = NextResponse.json({ data: saved });
    res.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.headers.set("Pragma", "no-cache");
    res.headers.set("Expires", "0");
    return res;
  } catch (e) {
    return bad((e as Error).message || "invalid json");
  }
}

export async function OPTIONS() {
  return NextResponse.json({ ok: true }, { status: 200 });
}


