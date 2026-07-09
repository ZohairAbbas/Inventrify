import type { ReactNode } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}

export function Drawer({ open, onClose, children }: Props) {
  if (!open) return null;

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(20,19,16,.3)",
          zIndex: 50,
        }}
      />
      <div
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: "440px",
          maxWidth: "100vw",
          background: "#fff",
          boxShadow: "-14px 0 40px rgba(0,0,0,.18)",
          zIndex: 51,
          overflowY: "auto",
          animation: "invRise .22s ease",
        }}
      >
        {children}
      </div>
    </>
  );
}
