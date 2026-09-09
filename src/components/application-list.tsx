"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  activeApplicationStages,
  applicationStages,
  ApplicationCard,
  AttentionSummary,
  priorityLabel,
  priorities,
  stageLabel,
  type ApplicationView,
} from "@/components/domain";
import { SearchIcon } from "@/components/icons";
import { EmptyState, StatusPill } from "@/components/ui";

export function ApplicationList({ applications }: { applications: ApplicationView[] }) {
  const [view, setView] = useState<"board" | "table">("board");
  const [search, setSearch] = useState("");
  const [stage, setStage] = useState("ALL");
  const [priority, setPriority] = useState("ALL");
  const [attention, setAttention] = useState("ALL");
  const [showArchived, setShowArchived] = useState(false);

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("zh-CN");
    return applications.filter((item) => {
      if (!showArchived && item.stage === "ARCHIVED") return false;
      if (query && !`${item.companyName} ${item.positionTitle} ${item.cycleLabel ?? ""}`.toLocaleLowerCase("zh-CN").includes(query)) return false;
      if (stage !== "ALL" && item.stage !== stage) return false;
      if (priority !== "ALL" && item.priority !== priority) return false;
      if (attention !== "ALL" && item.attentionMode !== attention) return false;
      return true;
    });
  }, [applications, attention, priority, search, showArchived, stage]);

  const hasFilters = search || stage !== "ALL" || priority !== "ALL" || attention !== "ALL";
  const visibleTotal = showArchived ? applications.length : applications.filter((item) => item.stage !== "ARCHIVED").length;
  const clearFilters = () => {
    setSearch("");
    setStage("ALL");
    setPriority("ALL");
    setAttention("ALL");
  };

  return (
    <div className="application-list-shell">
      <div className="list-toolbar" aria-label="申请筛选">
        <div className="view-switch" aria-label="视图" role="group">
          <button aria-pressed={view === "board"} className={view === "board" ? "is-active" : ""} onClick={() => setView("board")} type="button">看板</button>
          <button aria-pressed={view === "table"} className={view === "table" ? "is-active" : ""} onClick={() => setView("table")} type="button">表格</button>
        </div>
        <label className="search-field">
          <SearchIcon size={17} />
          <span className="sr-only">搜索公司、岗位或批次</span>
          <input onChange={(event) => setSearch(event.target.value)} placeholder="搜索公司、岗位或批次" type="search" value={search} />
        </label>
        <label><span className="sr-only">筛选阶段</span><select className="select compact-select" onChange={(event) => setStage(event.target.value)} value={stage}><option value="ALL">全部阶段</option>{(showArchived ? applicationStages : activeApplicationStages).map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label>
        <label><span className="sr-only">筛选优先级</span><select className="select compact-select" onChange={(event) => setPriority(event.target.value)} value={priority}><option value="ALL">全部优先级</option>{priorities.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label>
        <label><span className="sr-only">筛选推进方式</span><select className="select compact-select" onChange={(event) => setAttention(event.target.value)} value={attention}><option value="ALL">全部推进方式</option><option value="ACTION">有下一步</option><option value="WAITING">等待中</option><option value="NEEDS_ACTION">缺少下一步</option></select></label>
        <label className="toolbar-check"><input checked={showArchived} onChange={(event) => { setShowArchived(event.target.checked); if (!event.target.checked && stage === "ARCHIVED") setStage("ALL"); }} type="checkbox" /><span>显示归档</span></label>
        {hasFilters ? <button className="button button-ghost button-compact" onClick={clearFilters} type="button">清除筛选</button> : null}
      </div>

      <div className="result-summary" role="status">显示 {filtered.length} / {visibleTotal} 条{showArchived ? "申请" : "活跃申请"}</div>

      {filtered.length === 0 ? (
        <div className="section-card"><EmptyState title="没有符合条件的申请" description="调整筛选条件，或者从一条新申请开始。" href={hasFilters ? undefined : "/applications/new"} actionLabel={hasFilters ? undefined : "新建申请"} />{hasFilters ? <div className="center-action"><button className="button" onClick={clearFilters} type="button">清除筛选</button></div> : null}</div>
      ) : view === "board" ? (
        <div className="board" aria-label="申请看板">
          {(showArchived ? applicationStages : activeApplicationStages).map(([code, label]) => {
            const items = filtered.filter((item) => item.stage === code);
            return (
              <section className="board-column" key={code}>
                <div className="board-column-heading"><h2>{label}</h2><span>{items.length}</span></div>
                <div className="board-cards">{items.length ? items.map((item) => <ApplicationCard application={item} key={item.id} />) : <p className="board-empty">暂无申请</p>}</div>
              </section>
            );
          })}
        </div>
      ) : (
        <div className="table-wrap section-card">
          <table className="data-table">
            <thead><tr><th>公司与岗位</th><th>阶段</th><th>优先级</th><th>下一步 / 等待</th><th><span className="sr-only">操作</span></th></tr></thead>
            <tbody>{filtered.map((item) => <tr key={item.id}><td><Link className="table-primary-link" href={`/applications/${item.id}`}><strong>{item.companyName}</strong><span>{item.positionTitle}{item.cycleLabel ? ` · ${item.cycleLabel}` : ""}</span></Link></td><td><StatusPill tone="info">{stageLabel(item.stage)}</StatusPill></td><td>{priorityLabel(item.priority)}</td><td><AttentionSummary application={item} /></td><td><Link className="text-link" href={`/applications/${item.id}`}>查看</Link></td></tr>)}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
