import { redis, DEPLOY_KEY, PROJECT_SET_KEY, DEPLOY_ZSET_KEY, DEPLOY_RECORD_PREFIX } from "@/lib/redis";
import { randomUUID } from "crypto";
import type { CreateDeployPayload, DeployRecord } from "@/lib/types";
import { promises as fs } from "fs";
import path from "path";

const MAX_ITEMS = 200; // 存储上限，页面只取最近20

// 本地持久化：未配置 Upstash 时使用文件存储，保证多请求间可见
// Vercel 生产环境下工作目录只读（/var/task），必须写入 /tmp
const IS_VERCEL = !!process.env.VERCEL;
const BASE_DIR = IS_VERCEL ? "/tmp" : process.cwd();
const DATA_DIR = path.join(BASE_DIR, ".data");
const DATA_FILE = path.join(DATA_DIR, "deploy.json");
// 在 Vercel 只读环境下，作为只读兜底从代码仓库内读取初始数据
const REPO_DATA_FILE = path.join(process.cwd(), ".data", "deploy.json");
// 开关：仅使用 Redis，禁用文件存储与回退
const REDIS_ONLY: boolean = String(process.env.REDIS_ONLY ?? "").toLowerCase() === "true" || process.env.REDIS_ONLY === "1";

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
  if (REDIS_ONLY) {
    return { records: [], projects: [] };
  }
  const parseState = (jsonStr: string): PersistedState => {
    const parsed = JSON.parse(jsonStr) as Partial<PersistedState>;
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
    return { records, projects };
  };

  // 1) 优先读取运行时数据文件（Vercel=/tmp，开发=repo）
  try {
    const buf = await fs.readFile(DATA_FILE, "utf8");
    const state = parseState(buf);
    // 若是 Vercel 且运行时文件空，则兜底读取仓库内数据
    if (IS_VERCEL && state.records.length === 0) {
      try {
        const fallback = await fs.readFile(REPO_DATA_FILE, "utf8");
        return parseState(fallback);
      } catch {
        // ignore
      }
    }
    return state;
  } catch {
    // 2) 兜底：读取仓库内的只读数据文件
    try {
      const fallback = await fs.readFile(REPO_DATA_FILE, "utf8");
      return parseState(fallback);
    } catch {
      return { records: [], projects: [] };
    }
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
    // 同步项目集合，供 /api/projects 读取
    await redis.sadd(PROJECT_SET_KEY, record.projectName);
  }

  // 文件持久化（无论是否配置 Redis，都写入，保证本地/无 Redis 时可查询）
  // 在只读环境（未切到 /tmp 之前）写入可能失败，这里兜底不影响请求成功
  if (!REDIS_ONLY) {
    try {
      const state = await loadState();
      state.records.unshift(record);
      if (state.records.length > MAX_ITEMS) state.records.length = MAX_ITEMS;
      if (!state.projects.includes(record.projectName)) state.projects.push(record.projectName);
      await saveState(state);
    } catch {
      // ignore file write errors in serverless read-only environments
    }
  }

  return record;
}

export async function getLatestDeployRecords(limit: number, projectNames?: string[] | undefined): Promise<DeployRecord[]> {
  const min = Date.now() - THIRTY_DAYS_MS;

  // 优先读取 Redis（生产环境），回退到文件（本地开发或未配置 Redis）
  if (redis) {
    try {
      // 新优先：按 ZSET + 单条键读取，保证排序与扩展性
      const ids = (await redis.zrange(DEPLOY_ZSET_KEY, 0, MAX_ITEMS - 1, { rev: true })) as unknown as string[];
      let fromRedis: DeployRecord[] = [];
      if (ids && ids.length > 0) {
        const keys = ids.map((id) => `${DEPLOY_RECORD_PREFIX}${id}`);
        const values = (await redis.mget(...(keys as [string, ...string[]]))) as unknown as (string | null)[];
        fromRedis = values
          .map((s) => {
            try {
              return s ? (JSON.parse(s) as DeployRecord) : null;
            } catch {
              return null;
            }
          })
          .filter(Boolean) as DeployRecord[];
      }

      // 兼容：ZSET 为空时回退到旧 List
      if (fromRedis.length === 0) {
        const items = await redis.lrange(DEPLOY_KEY, 0, MAX_ITEMS - 1);
        fromRedis = (items as unknown as string[])
          .map((s) => {
            try {
              return JSON.parse(s) as DeployRecord;
            } catch {
              return null;
            }
          })
          .filter(Boolean) as DeployRecord[];
      }

      let list = fromRedis.filter((r) => new Date(r.deployedAt).getTime() >= min);
      const normalized = projectNames && projectNames.length > 0 ? new Set(projectNames) : undefined;
      if (normalized) list = list.filter((x) => normalized.has(x.projectName));
      list.sort((a, b) => (a.deployedAt < b.deployedAt ? 1 : -1));
      // 当 Redis 返回为空（例如新部署或空库）时，继续回退到文件
      if (list.length > 0) return list.slice(0, limit);
    } catch {
      // 回退到文件
    }
  }

  if (REDIS_ONLY) {
    return [];
  }

  const state = await loadState();
  const list: DeployRecord[] = state.records.filter((r) => new Date(r.deployedAt).getTime() >= min);
  const normalized = projectNames && projectNames.length > 0 ? new Set(projectNames) : undefined;
  const filtered = normalized ? list.filter((x) => normalized.has(x.projectName)) : list;
  filtered.sort((a, b) => (a.deployedAt < b.deployedAt ? 1 : -1));
  return filtered.slice(0, limit);
}

export async function getAllProjects(): Promise<string[]> {
  // 优先从 Redis 读取项目集合
  if (redis) {
    try {
      const members = (await redis.smembers(PROJECT_SET_KEY)) as unknown as string[];
      const set: string[] = Array.isArray(members) ? members : [];
      if (set.length > 0) {
        return [...new Set(set)].sort();
      }
      // 兜底：从旧 List 中推断
      const items = await redis.lrange(DEPLOY_KEY, 0, MAX_ITEMS - 1);
      const parsed: DeployRecord[] = (items as unknown as string[])
        .map((s) => {
          try {
            return JSON.parse(s) as DeployRecord;
          } catch {
            return null as unknown as DeployRecord;
          }
        })
        .filter(Boolean) as DeployRecord[];
      const inferred = Array.from(new Set(parsed.map((r) => r.projectName)));
      if (inferred.length > 0) return inferred.sort();
    } catch {
      // 回退到文件
    }
  }

  if (REDIS_ONLY) {
    return [];
  }

  const state = await loadState();
  if (state.projects.length > 0) return [...state.projects].sort();
  // 兜底：当 projects 为空但已有记录时，从记录中推断
  if (state.records.length > 0) {
    const inferred = Array.from(new Set(state.records.map((r) => r.projectName)));
    return inferred.sort();
  }
  return [];
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
  let removedFile = 0;
  if (!REDIS_ONLY) {
    const state = await loadState();
    removedFile = state.records.length + state.projects.length;
    try {
      await ensureDataDir();
      await fs.writeFile(DATA_FILE, JSON.stringify({ records: [], projects: [] }, null, 2), "utf8");
    } catch {
      // ignore
    }
  }

  const cleared = removedRedis + removedFile;
  const usedRedis = !!redis;
  const usedFile = !REDIS_ONLY;
  const mode = usedRedis && usedFile ? ("redis|file" as const) : usedRedis ? ("redis" as const) : ("file" as const);
  return { cleared, mode };
}

