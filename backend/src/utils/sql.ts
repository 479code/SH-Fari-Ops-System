/** Builds a `%term%` LIKE pattern with the wildcard characters in `term` escaped. */
export function likeContains(term: string): string {
  return `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}
