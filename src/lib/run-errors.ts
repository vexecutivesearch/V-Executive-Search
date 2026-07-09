/** Split pipeline run messages into domain skips vs other failures. */
export function categorizeRunErrors(errors: string[]) {
  const domainSkipped: string[] = [];
  const other: string[] = [];

  for (const err of errors) {
    if (/no domain/i.test(err)) {
      domainSkipped.push(err);
    } else {
      other.push(err);
    }
  }

  return { domainSkipped, other };
}
