export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export async function uniqueSlug(
  base: string,
  exists: (slug: string) => Promise<boolean>,
): Promise<string> {
  let slug = slugify(base);
  if (!(await exists(slug))) return slug;
  let counter = 2;
  while (await exists(`${slug}-${counter}`)) {
    counter += 1;
  }
  return `${slug}-${counter}`;
}
