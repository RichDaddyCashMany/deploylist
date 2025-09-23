import { redis, DEPLOY_KEY, PROJECT_SET_KEY, DEPLOY_ZSET_KEY, DEPLOY_RECORD_PREFIX } from "@/lib/redis";
import { randomUUID } from "crypto";
import type { CreateDeployPayload, DeployRecord } from "@/lib/types";
// 仅使用 Redis（无文件/内存兜底）

const MAX_ITEMS = 200; // 存储上限，页面只取最近20

// 文件/内存持久化相关逻辑已删除
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function coerceRecord(raw: unknown): DeployRecord | null {
  try {
    if (raw == null) return null;
    if (typeof raw === "string") {
      const parsed = JSON.parse(raw) as Partial<DeployRecord>;
      if (parsed && parsed.id && parsed.deployedAt) return parsed as DeployRecord;
      return null;
    }
    if (typeof raw === "object") {
      const obj = raw as Partial<DeployRecord>;
      if (obj && obj.id && obj.deployedAt) return obj as DeployRecord;
      return null;
    }
    return null;
  } catch {
    return null;
  }
}


function resolveDeployedAt(input?: string): string {
  const raw = (input ?? "").trim();
  if (!raw) return new Date().toISOString();
  const dt = new Date(raw);
  if (Number.isNaN(dt.getTime())) return new Date().toISOString();
  return dt.toISOString();
}

export async function addDeployRecord(payload: CreateDeployPayload): Promise<DeployRecord> {
  if (!redis) {
    throw new Error("Redis 未配置：请设置 UPSTASH_REDIS_REST_URL 与 UPSTASH_REDIS_REST_TOKEN");
  }
  const record: DeployRecord = {
    id: randomUUID(),
    ...payload,
    deployedAt: resolveDeployedAt(payload.deployedAt),
  };

  // 新：按单条键 + ZSET 排序索引，并设置30天过期
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

  // 文件持久化已移除

  return record;
}

export async function getLatestDeployRecords(limit: number, projectNames?: string[] | undefined): Promise<DeployRecord[]> {
  const min = Date.now() - THIRTY_DAYS_MS;

  if (!redis) {
    throw new Error("Redis 未配置：请设置 UPSTASH_REDIS_REST_URL 与 UPSTASH_REDIS_REST_TOKEN");
  }

  // 同时读取 ZSET 与旧 List，合并去重
  try {
      const ids = (await redis.zrange(DEPLOY_ZSET_KEY, 0, MAX_ITEMS - 1, { rev: true })) as unknown as string[];
      const zsetKeys = (ids ?? []).map((id) => `${DEPLOY_RECORD_PREFIX}${id}`);
      const zsetValues = zsetKeys.length > 0 ? ((await redis.mget(...(zsetKeys as [string, ...string[]]))) as unknown as unknown[]) : [];
      const fromZset: DeployRecord[] = (zsetValues ?? []).map((v) => coerceRecord(v)).filter(Boolean) as DeployRecord[];

      const listItems = (await redis.lrange(DEPLOY_KEY, 0, MAX_ITEMS - 1)) as unknown as unknown[];
      const fromList: DeployRecord[] = (listItems ?? []).map((v) => coerceRecord(v)).filter(Boolean) as DeployRecord[];

      const byId = new Map<string, DeployRecord>();
      for (const r of fromList) byId.set(r.id, r);
      for (const r of fromZset) byId.set(r.id, r);
      let list = Array.from(byId.values()).filter((r) => new Date(r.deployedAt).getTime() >= min);
      const normalized = projectNames && projectNames.length > 0 ? new Set(projectNames) : undefined;
      if (normalized) list = list.filter((x) => normalized.has(x.projectName));
      list.sort((a, b) => (a.deployedAt < b.deployedAt ? 1 : -1));
      // 当 Redis 返回为空（例如新部署或空库）时，继续回退到文件
      if (list.length > 0) return list.slice(0, limit);
    } catch {
      // ignore
    }

  // Redis 没数据
  return [];
}

export async function getAllProjects(): Promise<string[]> {
  if (!redis) {
    throw new Error("Redis 未配置：请设置 UPSTASH_REDIS_REST_URL 与 UPSTASH_REDIS_REST_TOKEN");
  }
  try {
    const members = (await redis.smembers(PROJECT_SET_KEY)) as unknown as string[];
    const set: string[] = Array.isArray(members) ? members : [];
    if (set.length > 0) {
      return [...new Set(set)].sort();
    }
    // 兜底：从旧 List 中推断
    const items = (await redis.lrange(DEPLOY_KEY, 0, MAX_ITEMS - 1)) as unknown as unknown[];
    const parsed: DeployRecord[] = (items ?? []).map((v) => coerceRecord(v)).filter(Boolean) as DeployRecord[];
    const inferred = Array.from(new Set(parsed.map((r) => r.projectName)));
    if (inferred.length > 0) return inferred.sort();
  } catch {
    // ignore
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

  // 文件模式已移除
  const removedFile = 0;

  const cleared = removedRedis + removedFile;
  const usedRedis = !!redis;
  const usedFile = false;
  const mode = usedRedis && usedFile ? ("redis|file" as const) : usedRedis ? ("redis" as const) : ("file" as const);
  return { cleared, mode };
}

