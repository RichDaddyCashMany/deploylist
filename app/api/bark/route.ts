import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const { title, body } = (await req.json()) as { title?: string; body?: string };
  const base = process.env.BARK_BASE;
  if (!base) {
    return NextResponse.json({ error: "BARK_BASE not set" }, { status: 400 });
  }
  const url = `${base}${encodeURIComponent(title ?? "通知")}/${encodeURIComponent(body ?? "")}`;
  const res = await fetch(url);
  const text = await res.text();
  return NextResponse.json({ ok: res.ok, text }, { status: res.ok ? 200 : 500 });
}


