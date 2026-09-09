import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowIcon } from "@/components/icons";

export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
        {description ? <p className="page-description">{description}</p> : null}
      </div>
      {action ? <div className="page-header-action">{action}</div> : null}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  href,
  actionLabel,
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  href?: string;
  actionLabel?: string;
}) {
  return (
    <div className="empty-state">
      {icon ? <div className="empty-icon">{icon}</div> : null}
      <h2>{title}</h2>
      <p>{description}</p>
      {href && actionLabel ? (
        <Link className="button button-primary" href={href}>{actionLabel}<ArrowIcon size={17} /></Link>
      ) : null}
    </div>
  );
}

export function StatusPill({ tone = "neutral", children }: { tone?: "neutral" | "danger" | "warning" | "success" | "info" | "accent"; children: ReactNode }) {
  return <span className={`status-pill tone-${tone}`}>{children}</span>;
}

export function Field({ label, hint, error, required, children }: { label: string; hint?: string; error?: string; required?: boolean; children: ReactNode }) {
  return (
    <label className={error ? "field has-error" : "field"}>
      <span className="field-label">{label}{required ? <span aria-hidden="true"> *</span> : null}</span>
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function Section({ title, description, children, className = "", id }: { title?: string; description?: string; children: ReactNode; className?: string; id?: string }) {
  return (
    <section className={`section-card ${className}`.trim()} id={id}>
      {title || description ? <div className="section-heading">{title ? <h2>{title}</h2> : null}{description ? <p>{description}</p> : null}</div> : null}
      {children}
    </section>
  );
}
