"use client";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="empty-state full-page-empty">
      <p className="empty-code">!</p>
      <h1>刚才的操作没有完成</h1>
      <p>你的输入仍可能保留在浏览器中。可以重试；若持续失败，请到设置页查看本地诊断。</p>
      <button className="button button-primary" onClick={reset} type="button">重新尝试</button>
    </div>
  );
}
