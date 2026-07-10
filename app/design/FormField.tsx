import type { ReactNode, SelectHTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes } from "react";

const labelStyle = { fontSize: "12px", color: "var(--inv-text-2)", display: "block", marginBottom: "6px" };
const controlStyle = {
  width: "100%",
  height: "40px",
  border: "1px solid var(--inv-input-border-2)",
  borderRadius: "10px",
  padding: "0 12px",
  fontSize: "13px",
  background: "#fff",
  outline: "none",
};

interface FieldProps {
  label: string;
  hint?: string;
  children: ReactNode;
}

export function FormField({ label, hint, children }: FieldProps) {
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      {children}
      {hint && <div style={{ fontSize: "11px", color: "var(--inv-muted)", marginTop: "5px" }}>{hint}</div>}
    </div>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} style={{ ...controlStyle, ...props.style }} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} style={{ ...controlStyle, height: "auto", padding: "10px 12px", ...props.style }} />;
}

export function SelectInput(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} style={{ ...controlStyle, ...props.style }} />;
}
