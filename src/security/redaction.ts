export function redactSecret(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  if (value.length <= 6) {
    return "***";
  }

  const prefix = value.slice(0, 3);
  const suffix = value.slice(-3);
  return `${prefix}***${suffix}`;
}
