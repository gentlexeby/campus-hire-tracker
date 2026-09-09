export default function Loading() {
  return (
    <div className="loading-page" role="status" aria-live="polite">
      <span className="loading-spinner" />
      <span>正在读取本地数据…</span>
    </div>
  );
}
