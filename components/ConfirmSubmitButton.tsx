"use client";

// A submit button that shows a native confirm() dialog before letting the
// form (a Server Action) actually submit — used for any destructive action
// (delete product, delete client, etc.) so a stray click can't wipe data.
export default function ConfirmSubmitButton({
  label,
  confirmText,
  className,
}: {
  label: string;
  confirmText: string;
  className?: string;
}) {
  return (
    <button
      type="submit"
      className={className}
      onClick={(e) => {
        if (!confirm(confirmText)) e.preventDefault();
      }}
    >
      {label}
    </button>
  );
}
