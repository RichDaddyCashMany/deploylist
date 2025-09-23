import { redis, DEPLOY_KEY, PROJECT_SET_KEY, DEPLOY_ZSET_KEY, DEPLOY_RECORD_PREFIX } from "@/lib/redis";
import { randomUUID } from "crypto";
import type { CreateDeployPayload, DeployRecord } from "@/lib/types";

const MAX_ITEMS = 200; // 存储上限，页面只取最近20

// 内存回退（仅用于未配置 Upstash 的本地开发）
// 使用 globalThis 在 Next 开发环境热更新（HMR）时尽量保持不丢失；进程重启仍会丢失。
declare global {
  // eslint-disable-next-line no-var
  var __flow_memList: DeployRecord[] | undefined;
  // eslint-disable-next-line no-var
  var __flow_memProjects: Set<string> | undefined;
}

const memoryList: DeployRecord[] = (globalThis as any).__flow_memList ?? [];
(globalThis as any).__flow_memList = memoryList;

const memoryProjects: Set<string> = (globalThis as any).__flow_memProjects ?? new Set<string>();
(globalThis as any).__flow_memProjects = memoryProjects;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export async function addDeployRecord(payload: CreateDeployPayload): Promise<DeployRecord> {
  const record: DeployRecord = {
    id: randomUUID(),
    deployedAt: payload.deployedAt ?? new Date().toISOString(),
    ...payload,
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
  } else {
    memoryList.unshift(record);
    if (memoryList.length > MAX_ITEMS) memoryList.length = MAX_ITEMS;
  }

  // 记录项目集合
  if (redis) {
    await redis.sadd(PROJECT_SET_KEY, record.projectName);
  } else {
    memoryProjects.add(record.projectName);
  }

  return record;
}

export async function getLatestDeployRecords(limit: number, projectNames?: string[] | undefined): Promise<DeployRecord[]> {
  let list: DeployRecord[];
  if (redis) {
    const now = Date.now();
    const minScore = now - THIRTY_DAYS_MS;
    // 最近30天内的id，倒序
    const ids = await redis.zrange(DEPLOY_ZSET_KEY, minScore, now, { byScore: true });
    ids.reverse();
    // 只取前 limit*5 个 id，再批量 mget
    const stringIds = (ids as unknown as string[]).slice(0, Math.min(ids.length, limit * 5));
    const keys = stringIds.map((id) => `${DEPLOY_RECORD_PREFIX}${id}`);
    const values = keys.length > 0 ? await redis.mget(...keys) : [] as (string | null)[];
    list = (values as (string | null)[])
      .map((s) => {
        if (!s) return null;
        try {
          return JSON.parse(s) as DeployRecord;
        } catch {
          return null;
        }
      })
      .filter((x): x is DeployRecord => Boolean(x));
  } else {
    // 内存：同时过滤30天
    const min = Date.now() - THIRTY_DAYS_MS;
    list = memoryList.filter((r) => new Date(r.deployedAt).getTime() >= min);
  }

  const normalized = projectNames && projectNames.length > 0 ? new Set(projectNames) : undefined;
  const filtered = normalized ? list.filter((x) => normalized.has(x.projectName)) : list;

  // 按时间倒序（lpush已经是倒序，但稳妥再排）
  filtered.sort((a, b) => (a.deployedAt < b.deployedAt ? 1 : -1));

  return filtered.slice(0, limit);
}

export async function getAllProjects(): Promise<string[]> {
  if (redis) {
    const arr = await redis.smembers<string[]>(PROJECT_SET_KEY);
    return arr.sort();
  }
  return Array.from(memoryProjects).sort();
}


