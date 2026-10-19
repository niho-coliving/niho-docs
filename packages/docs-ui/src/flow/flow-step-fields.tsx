import {
  type CompositionEventHandler,
  type Ref,
} from "react";

export type FlowStepFieldsClassNames = {
  root?: string;
  field?: string;
  label?: string;
  input?: string;
  textarea?: string;
  help?: string;
  error?: string;
};

export function FlowStepNameField(props: {
  value: string;
  onChange: (value: string) => void;
  inputRef?: Ref<HTMLInputElement>;
  disabled?: boolean;
  error?: string | null;
  ariaLabel?: string;
  placeholder?: string;
  className?: string;
  onCompositionStart?: CompositionEventHandler<HTMLInputElement>;
  onCompositionEnd?: CompositionEventHandler<HTMLInputElement>;
}) {
  return (
    <input
      ref={props.inputRef}
      type="text"
      value={props.value}
      disabled={props.disabled}
      aria-label={props.ariaLabel ?? "工程名"}
      aria-invalid={props.error ? true : undefined}
      placeholder={props.placeholder}
      onChange={(event) => props.onChange(event.currentTarget.value)}
      onCompositionStart={props.onCompositionStart}
      onCompositionEnd={props.onCompositionEnd}
      className={props.className}
    />
  );
}

export function FlowStepInstructionField(props: {
  value: string;
  onChange: (value: string) => void;
  inputRef?: Ref<HTMLTextAreaElement>;
  disabled?: boolean;
  error?: string | null;
  rows?: number;
  ariaLabel?: string;
  placeholder?: string;
  className?: string;
  onCompositionStart?: CompositionEventHandler<HTMLTextAreaElement>;
  onCompositionEnd?: CompositionEventHandler<HTMLTextAreaElement>;
}) {
  return (
    <textarea
      ref={props.inputRef}
      value={props.value}
      disabled={props.disabled}
      rows={props.rows}
      aria-label={props.ariaLabel ?? "指示文"}
      aria-invalid={props.error ? true : undefined}
      placeholder={props.placeholder}
      onChange={(event) => props.onChange(event.currentTarget.value)}
      onCompositionStart={props.onCompositionStart}
      onCompositionEnd={props.onCompositionEnd}
      className={props.className}
    />
  );
}

/**
 * Mac と Web が同じラベル・入力契約で使う、工程名と指示文の共通部品。
 * 保存・AI・並べ替えには関与せず、各面の既存レイアウトと focus 登録を props/ref で保つ。
 */
export function FlowStepFields(props: {
    name: string;
    instruction: string;
    onNameChange: (value: string) => void;
    onInstructionChange: (value: string) => void;
    nameError?: string | null;
    instructionError?: string | null;
    nameInputRef?: Ref<HTMLInputElement>;
    instructionInputRef?: Ref<HTMLTextAreaElement>;
    disabled?: boolean;
    instructionRows?: number;
    instructionHelp?: string | null;
    nameAriaLabel?: string;
    instructionAriaLabel?: string;
    namePlaceholder?: string;
    instructionPlaceholder?: string;
    classNames?: FlowStepFieldsClassNames;
    onNameCompositionStart?: CompositionEventHandler<HTMLInputElement>;
    onNameCompositionEnd?: CompositionEventHandler<HTMLInputElement>;
    onInstructionCompositionStart?: CompositionEventHandler<HTMLTextAreaElement>;
    onInstructionCompositionEnd?: CompositionEventHandler<HTMLTextAreaElement>;
  }) {
  const classes = props.classNames ?? {};
  return (
    <div className={classes.root}>
      <label className={classes.field}>
        <span className={classes.label}>工程名</span>
        <FlowStepNameField
          inputRef={props.nameInputRef}
          value={props.name}
          disabled={props.disabled}
          error={props.nameError}
          ariaLabel={props.nameAriaLabel}
          placeholder={props.namePlaceholder}
          onChange={props.onNameChange}
          onCompositionStart={props.onNameCompositionStart}
          onCompositionEnd={props.onNameCompositionEnd}
          className={classes.input}
        />
        {props.nameError ? <span role="alert" className={classes.error}>{props.nameError}</span> : null}
      </label>
      <label className={classes.field}>
        <span className={classes.label}>指示文</span>
        <FlowStepInstructionField
          inputRef={props.instructionInputRef}
          value={props.instruction}
          disabled={props.disabled}
          rows={props.instructionRows}
          error={props.instructionError}
          ariaLabel={props.instructionAriaLabel}
          placeholder={props.instructionPlaceholder}
          onChange={props.onInstructionChange}
          onCompositionStart={props.onInstructionCompositionStart}
          onCompositionEnd={props.onInstructionCompositionEnd}
          className={classes.textarea}
        />
        {props.instructionHelp ? <span className={classes.help}>{props.instructionHelp}</span> : null}
        {props.instructionError ? <span role="alert" className={classes.error}>{props.instructionError}</span> : null}
      </label>
    </div>
  );
}
