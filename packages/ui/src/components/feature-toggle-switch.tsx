"use client";

/** NIHO 共通の 24×44px（sm は見た目20×36px・操作領域24×36px）ON/OFF スイッチ。 */
export function FeatureToggleSwitch(props: {
  id?: string;
  checked: boolean;
  disabled: boolean;
  onChange: (nextChecked: boolean) => void;
  ariaLabel: string;
  /** "md"（既定）: 設定行 / "sm": 表の行など密度の高い面。 */
  size?: "md" | "sm";
  /** Tailwind を使わない面が、同じ primitive へ見た目を足すための class。 */
  className?: string;
  thumbClassName?: string;
}) {
  const { id, checked, disabled, onChange, ariaLabel, size = "md", className = "", thumbClassName = "" } = props;
  const buttonSizeClass = size === "sm" ? "h-6 w-9" : "h-6 w-11";
  const trackSizeClass = size === "sm" ? "h-5 w-9" : "h-6 w-11";
  const trackTopClass = size === "sm" ? "top-0.5" : "top-0";
  const knobSizeClass = size === "sm" ? "h-4 w-4" : "h-5 w-5";
  const knobTopClass = size === "sm" ? "top-1" : "top-[2px]";
  const knobCheckedClass = size === "sm" ? "translate-x-4" : "translate-x-5";
  return (
    <div className={`inline-flex items-center ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`niho-feature-toggle-switch relative ${buttonSizeClass} rounded-full border-0 bg-transparent p-0 ${
          disabled ? "cursor-not-allowed" : "cursor-pointer"
        } ${className}`.trim()}
      >
        <span
          aria-hidden="true"
          className={`niho-feature-toggle-switch__track absolute left-0 ${trackTopClass} ${trackSizeClass} rounded-full border transition-all ${
            checked
              ? "border-niho-accent-ink bg-niho-accent-ink shadow-sm"
              : "border-[#D9DDD4] bg-[#D8D8D0]"
          } motion-reduce:transition-none`}
        />
        <span
          className={`niho-feature-toggle-switch__thumb absolute left-[2px] ${knobTopClass} ${knobSizeClass} rounded-full bg-white shadow-sm transition-transform duration-200 ${
            checked ? knobCheckedClass : "translate-x-0"
          } motion-reduce:transition-none ${thumbClassName}`.trim()}
        />
      </button>
    </div>
  );
}
