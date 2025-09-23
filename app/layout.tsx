import "@arco-design/web-react/dist/css/arco.css";
import type { Metadata } from "next";
import React from "react";

export const metadata: Metadata = {
  title: "流水线部署信息",
  description: "展示最近的部署记录",
  icons: {
    icon: [
      { url: "/images/favicon.png", type: "image/png" },
      { url: "/images/favicon.ico", type: "image/x-icon" },
    ],
    shortcut: [{ url: "/images/favicon.ico", type: "image/x-icon" }],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}


