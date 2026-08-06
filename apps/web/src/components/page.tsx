import type { ReactNode } from "react";

export function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }): ReactNode {
  return <header className="page-header"><div><span>{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{action ? <div className="page-header__action">{action}</div> : null}</header>;
}

export function SkeletonPage(): ReactNode {
  return <div className="skeleton-page" aria-label="正在加载"><div /><div /><div /></div>;
}
