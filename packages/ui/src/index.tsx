import type { ButtonHTMLAttributes, ReactNode } from "react";

export function Button({
  children,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) {
  return (
    <button className={`button ${className}`.trim()} {...props}>
      {children}
    </button>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "positive" | "warning";
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

