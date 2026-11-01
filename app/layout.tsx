import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "旸隅 · 摄影作品集",
  description: "旸隅的 Cosplay 摄影作品集，包含场照与正片两个系列。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
