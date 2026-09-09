import type { Metadata } from "next";
import { PageHeader, Section, StatusPill } from "@/components/ui";
import { getHealthStatus } from "@/lib/services";

export const metadata: Metadata = { title: "设置" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  let health: Awaited<ReturnType<typeof getHealthStatus>> | null = null;
  try {
    health = await getHealthStatus();
  } catch {
    health = null;
  }

  return (
    <>
      <PageHeader eyebrow="本地应用" title="设置" description="查看运行状态与当前版本的能力边界。" />
      <div className="settings-grid">
        <Section title="运行状态" description="只显示技术状态，不读取或展示个人记录。">
          <div className="settings-row"><div><strong>本地数据库</strong><small>申请、事件和时间线的事实来源</small></div>{health?.databaseReadable ? <span className="safe-badge">正常</span> : <StatusPill tone="danger">不可用</StatusPill>}</div>
          <div className="settings-row"><div><strong>数据结构</strong><small>Schema {health?.schemaVersion ?? "—"}</small></div>{health?.schemaCompatible ? <span className="safe-badge">兼容</span> : <StatusPill tone="danger">需检查</StatusPill>}</div>
          <div className="settings-row"><div><strong>当前版本</strong><small>秋招进度板 M1-A</small></div><StatusPill tone="accent">v{health?.appVersion ?? "0.1.0"}</StatusPill></div>
        </Section>

        <Section title="隐私与网络" description="当前版本没有账号、云同步或默认遥测。">
          <div className="settings-row"><div><strong>存储位置</strong><small>当前 Windows 用户的 LocalAppData</small></div><span className="safe-badge">仅本机</span></div>
          <div className="settings-row"><div><strong>未保存备注草稿</strong><small>暂存在当前浏览器的 IndexedDB；正式保存后仅清理内容相同的候选</small></div><span className="safe-badge">本浏览器</span></div>
          <div className="settings-row"><div><strong>服务地址</strong><small>固定监听 127.0.0.1:3210</small></div><span className="safe-badge">仅回环</span></div>
          <div className="settings-row"><div><strong>外部连接</strong><small>核心功能不请求 AI、统计或第三方内容</small></div><StatusPill>无</StatusPill></div>
        </Section>

        <Section title="当前可用" description="这是一条精简但完整的本地推进闭环。">
          <ul className="plain-list"><li>申请、阶段和三种推进状态</li><li>面试、笔试、截止与复查事件</li><li>带浏览器临时草稿恢复的申请备注</li><li>今日风险队列、看板 / 表格和日程列表</li><li>不可直接编辑的申请时间线</li></ul>
        </Section>

        <Section title="后续提供" description="下列能力尚未开启，界面不会暗示它们已经可用。">
          <ul className="plain-list muted"><li>附件、JD 与面经资料库</li><li>表格导入、完整备份与恢复脚本</li><li>ICS 日历导出、PWA、通知与 AI</li><li>浏览器草稿不是离线正式编辑或跨设备同步</li></ul>
        </Section>
      </div>
    </>
  );
}
