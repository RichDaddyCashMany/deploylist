import { NextResponse } from "next/server";
import { getAllProjects } from "@/lib/db";

export async function GET() {
  const data = await getAllProjects();
  return NextResponse.json({ data });
}


