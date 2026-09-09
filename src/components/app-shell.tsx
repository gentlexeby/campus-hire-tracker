"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import {
  ApplicationsIcon,
  CalendarIcon,
  PlusIcon,
  SettingsIcon,
  SparkIcon,
  TodayIcon,
} from "@/components/icons";

const navigation = [
  { href: "/", label: "今日", icon: TodayIcon },
  { href: "/applications", label: "申请", icon: ApplicationsIcon },
  { href: "/calendar", label: "日历", icon: CalendarIcon },
  { href: "/settings", label: "设置", icon: SettingsIcon },
] as const;

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="app-frame">
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <aside className="sidebar" aria-label="主导航">
        <Link className="brand" href="/" aria-label="秋招进度板首页">
          <span className="brand-mark"><SparkIcon size={22} /></span>
          <span>
            <strong>秋招进度板</strong>
            <small>Campus tracker</small>
          </span>
        </Link>
        <nav className="nav-list">
          {navigation.map((item) => {
            const Icon = item.icon;
            const active = isActive(pathname, item.href);
            return (
              <Link
                aria-current={active ? "page" : undefined}
                className={active ? "nav-item is-active" : "nav-item"}
                href={item.href}
                key={item.href}
              >
                <Icon size={20} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="sidebar-spacer" />
        <div className="privacy-note">
          <span className="status-dot" />
          <div><strong>仅保存在此设备</strong><small>无账号 · 无云同步</small></div>
        </div>
      </aside>

      <div className="app-column">
        <header className="topbar">
          <div className="mobile-brand"><span className="brand-mark small"><SparkIcon size={17} /></span><strong>秋招进度板</strong></div>
          <div className="topbar-spacer" />
          <Link className="button button-primary button-compact" href="/applications/new">
            <PlusIcon size={18} />
            <span>新建申请</span>
          </Link>
        </header>
        <main id="main-content" className="main-content">{children}</main>
      </div>

      <nav className="bottom-nav" aria-label="移动端主导航">
        {navigation.map((item) => {
          const Icon = item.icon;
          const active = isActive(pathname, item.href);
          return (
            <Link
              aria-current={active ? "page" : undefined}
              className={active ? "bottom-nav-item is-active" : "bottom-nav-item"}
              href={item.href}
              key={item.href}
            >
              <Icon size={21} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
