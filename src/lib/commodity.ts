import type { PrismaClient } from '@prisma/client';

function slugToCode(raw: string): string {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function titleName(raw: string): string {
  const s = String(raw || '').trim();
  if (!s) return 'Unknown';
  return s
    .split(/[\s_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Resolves a commodity from code (TOMATO) or common name (tomato) and creates a row if missing.
 */
export async function findOrCreateCommodity(prisma: PrismaClient, input: string) {
  const trimmed = String(input || '').trim();
  if (!trimmed) {
    throw new Error('commodity is required');
  }
  const byCode = slugToCode(trimmed);
  const existing = await prisma.commodity.findUnique({ where: { code: byCode } });
  if (existing) return existing;

  const byName = await prisma.commodity.findFirst({
    where: { name: { equals: trimmed, mode: 'insensitive' } },
  });
  if (byName) return byName;

  return prisma.commodity.create({
    data: {
      code: byCode,
      name: titleName(trimmed.replace(/_/g, ' ')),
      category: 'vegetable',
      defaultShelfLifeDays: 7,
    },
  });
}
