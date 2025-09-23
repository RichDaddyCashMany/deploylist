import { NextRequest, NextResponse } from "next/server";
import { clearAllData } from "@/lib/db";

function bad(msg: string, code = 400) {
  return NextResponse.json({ error: msg }, { status: code });
}

export async function POST(_req: NextRequest) {
  try {
    const result = await clearAllData();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return bad((e as Error).message || "clean failed", 500);
  }
}

export async function OPTIONS() {
  return NextResponse.json({ ok: true }, { status: 200 });
}

 