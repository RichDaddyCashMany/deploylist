"use client";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Select, List, Typography, Tag, Space, Divider, Spin, Message, Progress } from "@arco-design/web-react";
import dayjs from "dayjs";
import type { DeployRecord } from "@/lib/types";

const POLL_MS = 5000;
const MAX_SHOW = 20;
const LS_LAST_NOTIFIED_KEY = "deploylist:lastNotifiedId";
const DEFAULT_FAVICON_PNG = "/images/favicon.png";
const DEFAULT_FAVICON_ICO = "/images/favicon.ico";
const NEW_MESSAGE_FAVICON_PNG = "/images/favicon-new-message.png";
const NEW_MESSAGE_FAVICON_ICO = "/images/favicon-new-message.ico";
const OFFLINE_FAVICON_PNG = "/images/favicon-off-line.png";
const OFFLINE_FAVICON_ICO = "/images/favicon-off-line.ico";
const QUOTA_MS = 60_000 * 60 * 8; // 每次刷新后的轮询额度：8小时
const COUNTDOWN_STEP_MS = 200; // 倒计时刷新频率
const MAX_SEEN_CACHE = 500; // 本地已见消息缓存上限

function extractPgyerLinks(note: string): string[] {
  const regex = /https:\/\/www\.pgyer\.com\/[A-Za-z0-9]+/g;
  const matches = note.match(regex) || [];
  return matches.map((m) => m.slice(0));
}

function buildQrImageUrl(link: string, size: number = 80): string {
  const dim = `${size}x${size}`;
  return `https://api.qrserver.com/v1/create-qr-code/?size=${dim}&data=${encodeURIComponent(link)}`;
}

type SegValue = string[]; // 多选的项目名数组，空数组表示全部

async function fetchJSON<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`fetch ${url} failed`);
  return res.json();
}

function statusTag(status: DeployRecord["status"]) {
  const color = status === "success" ? "green" : status === "failed" ? "red" : status === "running" ? "arcoblue" : "gray";
  return <Tag color={color}>{status}</Tag>;
}

export default function YoupikPage() {
  const [projects, setProjects] = useState<string[]>([]);
  const [seg, setSeg] = useState<SegValue>([]);
  const [list, setList] = useState<DeployRecord[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [polling, setPolling] = useState<boolean>(false);
  const lastFirstIdRef = useRef<string | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const quotaTimerRef = useRef<number | null>(null);
  const quotaStartTimeRef = useRef<number>(Date.now());
  const [quotaMsLeft, setQuotaMsLeft] = useState<number>(QUOTA_MS);
  const [quotaEnded, setQuotaEnded] = useState<boolean>(false);
  const suppressNotifyRef = useRef<boolean>(false);

  const selectOptions = useMemo(() => projects.map((p) => ({ label: p, value: p })), [projects]);

  const query = useCallback(async () => {
    let q = "";
    if (seg.length > 0) {
      // 使用重复 query 参数，兼容后端多种解析
      q = seg.map((s) => `&projectName=${encodeURIComponent(s)}`).join("");
    }
    const data = await fetchJSON<{ data: DeployRecord[] }>(`/api/deploy?limit=${MAX_SHOW}${q}`);
    return data.data;
  }, [seg]);

  const refreshProjects = useCallback(async () => {
    try {
      const res = await fetchJSON<{ data: string[] }>("/api/projects");
      setProjects(res.data);
    } catch {
      // ignore
    }
  }, []);

  const handleSegChange = useCallback((value: string[]) => {
    // 用户主动变更筛选，不应触发“新记录”通知
    suppressNotifyRef.current = true;
    setSeg(value);
  }, []);

  const poll = useCallback(async () => {
    try {
      setPolling(true);
      const data = await query();
      setList(data);
      if (data.length > 0) {
        const ids = data.map((x) => x.id);
        const seen = new Set(readSeenIds());
        if (seen.size === 0) {
          // 首次加载：只记录，不通知
          writeSeenIds(ids);
        } else {
          const newIds = ids.filter((id) => !seen.has(id));
          if (newIds.length > 0) {
            if (suppressNotifyRef.current) {
              // 由筛选变更导致列表变化：只更新缓存，不通知
              writeSeenIds([...Array.from(seen), ...ids]);
              suppressNotifyRef.current = false;
            } else {
              if ("Notification" in window) {
                if (Notification.permission === "granted") {
                  const firstNew = data.find((x) => newIds.includes(x.id)) || data[0];
                  new Notification(firstNew.projectName, { body: `${firstNew.commit}` });
                } else if (Notification.permission !== "denied") {
                  await Notification.requestPermission();
                }
              }
              const barkBase = process.env.NEXT_PUBLIC_BARK_BASE || "";
              if (barkBase) {
                const firstNew = data.find((x) => newIds.includes(x.id)) || data[0];
                const text = encodeURIComponent(`${firstNew.projectName}`);
                fetch(`${barkBase}${text}`, { method: "GET" }).catch(() => {});
              }
              writeSeenIds([...Array.from(seen), ...ids]);
              setFaviconsToNewMessage();
            }
          } else {
            // 没有新记录，同步缓存为并集（防止缓存丢失）
            writeSeenIds([...Array.from(seen), ...ids]);
          }
        }
        lastFirstIdRef.current = ids[0] ?? null;
      }
    } catch (e) {
      Message.error((e as Error).message);
    } finally {
      setLoading(false);
      setTimeout(() => {
        setPolling(false);
      }, 200);
    }
  }, [query]);

  // 仅修改现有三条 link 的 href
  function findFaviconLinks() {
    const shortcut = document.querySelector('link[rel="shortcut icon"]') as HTMLLinkElement | null;
    const png = document.querySelector('link[rel="icon"][type="image/png"]') as HTMLLinkElement | null;
    const ico = document.querySelector('link[rel="icon"][type="image/x-icon"]') as HTMLLinkElement | null;
    return { shortcut, png, ico };
  }

  function setFaviconsToNewMessage() {
    if (typeof document === "undefined") return;
    const { shortcut, png, ico } = findFaviconLinks();
    if (shortcut) shortcut.href = NEW_MESSAGE_FAVICON_ICO;
    if (png) png.href = NEW_MESSAGE_FAVICON_PNG;
    if (ico) ico.href = NEW_MESSAGE_FAVICON_ICO;
  }

  function setFaviconsToDefault() {
    if (typeof document === "undefined") return;
    const { shortcut, png, ico } = findFaviconLinks();
    if (shortcut) shortcut.href = DEFAULT_FAVICON_ICO;
    if (png) png.href = DEFAULT_FAVICON_PNG;
    if (ico) ico.href = DEFAULT_FAVICON_ICO;
  }

  function setFaviconsToOffline() {
    if (typeof document === "undefined") return;
    const { shortcut, png, ico } = findFaviconLinks();
    if (shortcut) shortcut.href = OFFLINE_FAVICON_ICO;
    if (png) png.href = OFFLINE_FAVICON_PNG;
    if (ico) ico.href = OFFLINE_FAVICON_ICO;
  }

  function readSeenIds(): string[] {
    if (typeof window === "undefined") return [];
    const raw = window.localStorage.getItem(LS_LAST_NOTIFIED_KEY);
    if (raw == null) return [];
    try {
      if (raw.startsWith("[")) {
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
      }
      return [raw]; // 兼容旧版本：此前仅存单个 id
    } catch {
      return [raw];
    }
  }

  function writeSeenIds(ids: string[]) {
    if (typeof window === "undefined") return;
    const unique = Array.from(new Set(ids));
    const trimmed = unique.slice(0, MAX_SEEN_CACHE);
    window.localStorage.setItem(LS_LAST_NOTIFIED_KEY, JSON.stringify(trimmed));
  }

  useEffect(() => {
    // 初次加载项目列表
    refreshProjects()
      .catch(() => setProjects([]));
  }, []);

  useEffect(() => {
    if (quotaEnded) {
      return () => {};
    }
    setLoading(true);
    poll();
    pollTimerRef.current = window.setInterval(() => {
      poll();
    }, POLL_MS);
    return () => {
      if (pollTimerRef.current !== null) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [poll, quotaEnded]);

  // 页面刷新后开启一次额度倒计时（60秒）；额度用尽则停止轮询
  useEffect(() => {
    quotaStartTimeRef.current = Date.now();
    setQuotaMsLeft(QUOTA_MS);
    setQuotaEnded(false);
    quotaTimerRef.current = window.setInterval(() => {
      const elapsed = Date.now() - quotaStartTimeRef.current;
      const left = Math.max(0, QUOTA_MS - elapsed);
      setQuotaMsLeft(left);
      if (left <= 0) {
        setQuotaEnded(true);
      }
    }, COUNTDOWN_STEP_MS);
    return () => {
      if (quotaTimerRef.current !== null) {
        clearInterval(quotaTimerRef.current);
        quotaTimerRef.current = null;
      }
    };
  }, []);

  // 当额度结束时，清理轮询与倒计时计时器
  useEffect(() => {
    if (!quotaEnded) return;
    if (pollTimerRef.current !== null) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (quotaTimerRef.current !== null) {
      clearInterval(quotaTimerRef.current);
      quotaTimerRef.current = null;
    }
  }, [quotaEnded]);

  // 当额度结束时，设置离线 favicon
  useEffect(() => {
    if (quotaEnded) {
      setFaviconsToOffline();
    }
  }, [quotaEnded]);

  
  

  // 当页面（标签）重新可见或获得焦点时，恢复默认 favicon（仅改 href）
  useEffect(() => {
    const handleMouseEnter = () => {
      setFaviconsToDefault();
    }
    document.addEventListener('mouseenter', handleMouseEnter);
    return () => {
      document.removeEventListener('mouseenter', handleMouseEnter);
    }
  }, []);


  return (
    <div style={{ maxWidth: 960, margin: "0 auto", padding: 24 }}>
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <div>
          <Typography.Title heading={3} style={{ marginBottom: 0 }}>
            流水线部署信息
            <span style={{ marginLeft: 12, verticalAlign: "middle", display: "inline-flex", alignItems: "center", gap: 8 }}>
              {quotaEnded ? (
                <div style={{color: "red", fontSize: 16}}>
                  <span style={{ color: "blue", cursor: "pointer" }} onClick={() => {
                    window.location.reload();
                  }} >刷新网页</span>后重新开始轮询
                </div>
              ) : null}
            </span>
          </Typography.Title>
        </div>
        <Select
          mode="multiple"
          allowClear
          placeholder="筛选项目"
          value={seg}
          onChange={handleSegChange}
          onVisibleChange={(visible: boolean) => {
            if (visible) {
              refreshProjects();
            }
          }}
          style={{ width: "100%" }}
          options={selectOptions}
        />
        {loading ? (
          <Spin style={{ width: "100%" }} />
        ) : (
          <List
            bordered
            size="small"
            dataSource={list}
            render={(item) => {
              const isFresh = dayjs().diff(dayjs(item.deployedAt), "minute") < 1;
              const pgyerLinks = extractPgyerLinks(item.note || "");
              return (
                <List.Item
                  key={item.id}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-start",
                    background: isFresh ? "rgba(82,196,26,0.08)" : "#fafafa",
                  }}
                >
                  <div style={{ width: "100%", display: "flex", flexDirection: "row", gap: 8, alignItems: "center" }}>
                    <Tag color={item.projectName.includes('生产') || item.projectName.includes('prod') ? 'red' : 'blue'} bordered>{item.projectName}</Tag>
                    {/* <Tag bordered>环境 {item.environment}</Tag> */}
                    <Tag bordered>{item.branch}分支</Tag>
                    {statusTag(item.status)}
                    <Typography.Text bold>{dayjs(item.deployedAt).format("YYYY-MM-DD HH:mm:ss")}</Typography.Text>
                  </div>
                  <div style={{ marginTop: 8, opacity: isFresh ? 1 : 0.7 }}>
                    <Typography.Text type="secondary">运行人：</Typography.Text>
                    <Typography.Text>{item.operator}</Typography.Text>
                  </div>
                  <div style={{ marginTop: 4, opacity: isFresh ? 1 : 0.7 }}>
                    <Typography.Text type="secondary">代码提交记录：</Typography.Text>
                    <Typography.Paragraph style={{ display: "inline", marginBottom: 0 }}>{item.commit}</Typography.Paragraph>
                  </div>
                  {item.note ? (
                    <div style={{ marginTop: 4, opacity: isFresh ? 1 : 0.7 }}>
                      <Typography.Text type="secondary">备注：</Typography.Text>
                      <Typography.Paragraph style={{ display: "inline", marginBottom: 0 }}>{item.note}</Typography.Paragraph>
                      {pgyerLinks.length > 0 ? (
                        <div style={{ marginTop: 8 }}>
                          {pgyerLinks.map((link) => (
                            <div key={link} style={{ marginTop: 4 }}>
                              <img src={buildQrImageUrl(link, 240)} alt="二维码" width={120} height={120} />
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </List.Item>
              );
            }}
            pagination={false}
          />
        )}
      </Space>
    </div>
  );
}


