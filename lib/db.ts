import { redis, DEPLOY_KEY, PROJECT_SET_KEY, DEPLOY_ZSET_KEY, DEPLOY_RECORD_PREFIX } from "@/lib/redis";
import { randomUUID } from "crypto";
import type { CreateDeployPayload, DeployRecord } from "@/lib/types";
import { promises as fs } from "fs";
import path from "path";

const MAX_ITEMS = 200; // 存储上限，页面只取最近20

// 本地持久化：未配置 Upstash 时使用文件存储，保证多请求间可见
const DATA_DIR = path.join(process.cwd(), ".data");
const DATA_FILE = path.join(DATA_DIR, "deploy.json");

interface PersistedState {
  records: DeployRecord[];
  projects: string[];
}

async function ensureDataDir(): Promise<void> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch {
    // ignore
  }
}

async function loadState(): Promise<PersistedState> {
  try {
    const buf = await fs.readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(buf) as Partial<PersistedState>;
    const recordsRaw: DeployRecord[] = Array.isArray(parsed.records) ? (parsed.records as DeployRecord[]) : [];
    let changed = false;
    const records: DeployRecord[] = recordsRaw.map((r) => {
      const ts = r.deployedAt ? Date.parse(r.deployedAt) : NaN;
      if (!r.deployedAt || Number.isNaN(ts)) {
        changed = true;
        return { ...r, deployedAt: new Date().toISOString() } as DeployRecord;
      }
      return r;
    });
    const projects: string[] = Array.isArray(parsed.projects) ? (parsed.projects as string[]) : [];
    if (changed) {
      await saveState({ records, projects });
    }
    return { records, projects };
  } catch {
    return { records: [], projects: [] };
  }
}

async function saveState(state: PersistedState): Promise<void> {
  await ensureDataDir();
  const content = JSON.stringify(state, null, 2);
  await fs.writeFile(DATA_FILE, content, "utf8");
}
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function resolveDeployedAt(input?: string): string {
  const raw = (input ?? "").trim();
  if (!raw) return new Date().toISOString();
  const dt = new Date(raw);
  if (Number.isNaN(dt.getTime())) return new Date().toISOString();
  return dt.toISOString();
}

export async function addDeployRecord(payload: CreateDeployPayload): Promise<DeployRecord> {
  const record: DeployRecord = {
    id: randomUUID(),
    ...payload,
    deployedAt: resolveDeployedAt(payload.deployedAt),
  };

  // 新：按单条键 + ZSET 排序索引，并设置30天过期
  if (redis) {
    const key = `${DEPLOY_RECORD_PREFIX}${record.id}`;
    const score = new Date(record.deployedAt).getTime();
    await redis.set(key, JSON.stringify(record), { ex: Math.floor(THIRTY_DAYS_MS / 1000) });
    await redis.zadd(DEPLOY_ZSET_KEY, { score, member: record.id });
    // 移除超过30天的索引
    await redis.zremrangebyscore(DEPLOY_ZSET_KEY, 0, score - THIRTY_DAYS_MS - 1);
    // 兼容：旧 List 保留写入以便之前页面还能读取（可选）
    await redis.lpush(DEPLOY_KEY, JSON.stringify(record));
    await redis.ltrim(DEPLOY_KEY, 0, MAX_ITEMS - 1);
  }

  // 文件持久化（无论是否配置 Redis，都写入，保证本地查询可用）
  const state = await loadState();
  state.records.unshift(record);
  if (state.records.length > MAX_ITEMS) state.records.length = MAX_ITEMS;
  if (!state.projects.includes(record.projectName)) state.projects.push(record.projectName);
  await saveState(state);

  return record;
}

export async function getLatestDeployRecords(limit: number, projectNames?: string[] | undefined): Promise<DeployRecord[]> {
  // 从本地文件加载（作为统一数据源），保证本地开发可见
  const state = await loadState();
  const min = Date.now() - THIRTY_DAYS_MS;
  const list: DeployRecord[] = state.records.filter((r) => new Date(r.deployedAt).getTime() >= min);

  const normalized = projectNames && projectNames.length > 0 ? new Set(projectNames) : undefined;
  const filtered = normalized ? list.filter((x) => normalized.has(x.projectName)) : list;

  // 按时间倒序（lpush已经是倒序，但稳妥再排）
  filtered.sort((a, b) => (a.deployedAt < b.deployedAt ? 1 : -1));

  return filtered.slice(0, limit);
}

export async function getAllProjects(): Promise<string[]> {
  const state = await loadState();
  return [...state.projects].sort();
}

// 清空所有数据：
// - Redis：删除当前数据库下的所有键（keys("*") + del）
// - 文件：删除 .data/deploy.json
export async function clearAllData(): Promise<{ cleared: number; mode: "redis|file" | "file" | "redis" }> {
  let removedRedis = 0;
  if (redis) {
    const keys = await redis.keys("*");
    if (keys.length > 0) {
      removedRedis = await redis.del(...(keys as [string, ...string[]]));
    }
  }

  // 统计文件中条目数量后清空
  const state = await loadState();
  const removedFile = state.records.length + state.projects.length;
  try {
    await ensureDataDir();
    await fs.writeFile(DATA_FILE, JSON.stringify({ records: [], projects: [] }, null, 2), "utf8");
  } catch {
    // ignore
  }

  const cleared = removedRedis + removedFile;
  if (redis && removedRedis > 0) return { cleared, mode: "redis|file" };
  if (redis) return { cleared, mode: "redis|file" };
  return { cleared, mode: "file" };
}

