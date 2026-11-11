export function errorProps(id: string, error: string | undefined) {
  return { 'aria-invalid': error ? true : undefined, 'aria-describedby': error ? `${id}-error` : undefined };
}

export function FieldError({ id, error }: { id: string; error: string | undefined }) {
  return error ? (
    <p id={`${id}-error`} className="field-error">
      {error}
    </p>
  ) : null;
}
