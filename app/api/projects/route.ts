import { NextRequest, NextResponse } from "next/server";
import { getLatestDeployRecords } from "@/lib/db";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const limit = Math.max(1, Math.min(1000, Number(searchParams.get("limit")) || 200));
  const records = await getLatestDeployRecords(limit);
  const projects = Array.from(new Set(records.map((r) => r.projectName))).sort();
  return NextResponse.json({ data: projects });
}


