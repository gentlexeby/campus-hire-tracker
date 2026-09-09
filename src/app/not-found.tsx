import Link from "next/link";

export default function NotFound() {
  return (
    <div className="empty-state full-page-empty">
      <p className="empty-code">404</p>
      <h1>没有找到这个页面</h1>
      <p>它可能已经被移动，或者对应记录已被删除。</p>
      <Link className="button button-primary" href="/">返回今日</Link>
    </div>
  );
}
