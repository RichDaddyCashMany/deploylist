import { Redis } from "@upstash/redis";

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;

export const redis: Redis | null = url && token ? new Redis({ url, token }) : null;

export const DEPLOY_KEY = "deploy_records"; // 旧的 List 索引（兼容保留，不再写入）
export const PROJECT_SET_KEY = "deploy_projects";
export const DEPLOY_ZSET_KEY = "deploy_records_z"; // 新的时间索引（score=毫秒时间戳，member=id）
export const DEPLOY_RECORD_PREFIX = "deploy_record:"; // 具体记录存储键前缀


