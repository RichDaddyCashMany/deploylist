import { NextRequest, NextResponse } from "next/server";
import { getLatestDeployRecords } from "@/lib/db";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const limit = Math.max(1, Math.min(1000, Number(searchParams.get("limit")) || 200));
  const records = await getLatestDeployRecords(limit);
  const projects = Array.from(new Set(records.map((r) => r.projectName))).sort();
  const res = NextResponse.json({ data: projects });
  res.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.headers.set("Pragma", "no-cache");
  res.headers.set("Expires", "0");
  return res;
}


