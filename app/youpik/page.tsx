"use client";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Select, List, Typography, Tag, Space, Divider, Spin, Message } from "@arco-design/web-react";
import dayjs from "dayjs";
import type { DeployRecord } from "@/lib/types";

const POLL_MS = 5000;
const MAX_SHOW = 20;
const LS_LAST_NOTIFIED_KEY = "deploylist:lastNotifiedId";

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

  const poll = useCallback(async () => {
    try {
      setPolling(true);
      const data = await query();
      setList(data);
      if (data.length > 0) {
        const newestId = data[0].id;
        if (typeof window !== "undefined") {
          const cachedId = window.localStorage.getItem(LS_LAST_NOTIFIED_KEY);
          if (cachedId === null) {
            // 首次加载：只记录，不通知
            window.localStorage.setItem(LS_LAST_NOTIFIED_KEY, newestId);
          } else if (cachedId !== newestId) {
            // 发现新记录：通知一次并更新缓存
            if ("Notification" in window) {
              if (Notification.permission === "granted") {
                new Notification("流水线部署完成", { body: `${data[0].projectName}` });
              } else if (Notification.permission !== "denied") {
                await Notification.requestPermission();
              }
            }
            // Bark 推送
            const barkBase = process.env.NEXT_PUBLIC_BARK_BASE || "";
            if (barkBase) {
              const text = encodeURIComponent(`${data[0].projectName}`);
              fetch(`${barkBase}${text}`, { method: "GET" }).catch(() => {});
            }
            window.localStorage.setItem(LS_LAST_NOTIFIED_KEY, newestId);
          }
        }
        lastFirstIdRef.current = newestId;
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

  useEffect(() => {
    // 初次加载项目列表
    fetchJSON<{ data: string[] }>("/api/projects")
      .then((res) => setProjects(res.data))
      .catch(() => setProjects([]));
  }, []);

  useEffect(() => {
    setLoading(true);
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => clearInterval(timer);
  }, [poll]);

  return (
    <div style={{ maxWidth: 960, margin: "0 auto", padding: 24 }}>
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <div>
          <Typography.Title heading={3} style={{ marginBottom: 0 }}>
            流水线部署信息
            {polling ? <Spin size={32} /> : null}
          </Typography.Title>
        </div>
        <Select
          mode="multiple"
          allowClear
          placeholder="筛选项目"
          value={seg}
          onChange={(v) => setSeg(v as string[])}
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
                    <Tag bordered>项目 {item.projectName}</Tag>
                    <Tag bordered>环境 {item.environment}</Tag>
                    <Tag bordered>分支 {item.branch}</Tag>
                    {statusTag(item.status)}
                    <Typography.Text bold>部署完成时间：{dayjs(item.deployedAt).format("YYYY-MM-DD HH:mm:ss")}</Typography.Text>
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


