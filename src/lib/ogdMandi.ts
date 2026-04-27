/**
 * India Open Government Data — AGMARKNET daily mandi prices (data.gov.in).
 * Register a free key: https://www.data.gov.in/
 *
 * Resource: Current daily price of various commodities from various markets (Mandi)
 */

import type { PrismaClient } from '../generated/prisma';

const OGD_DATASTORE_SEARCH = 'https://www.data.gov.in/api/3/action/datastore_search';
const DEFAULT_RESOURCE_ID = '9ef84268-d588-465a-a308-a864a43d0070';

type OgdRecord = {
  commodity?: string;
  variety?: string;
  state?: string;
  district?: string;
  market?: string;
  arrival_date?: string;
  min_price?: string | number;
  max_price?: string | number;
  modal_price?: string | number;
};

function parseArrivalDate(s: string | undefined): Date {
  if (!s) return new Date();
  const t = s.trim();
  const dmy = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dmy) {
    const d = Number(dmy[1]);
    const m = Number(dmy[2]) - 1;
    const y = Number(dmy[3]);
    return new Date(y, m, d);
  }
  const iso = Date.parse(t);
  if (!Number.isNaN(iso)) return new Date(iso);
  return new Date();
}

function num(v: string | number | undefined): number {
  if (v == null) return 0;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** Map end-user region text to an OGD `state` filter (AGMARKNET). */
export function userRegionToOgdState(userRegion: string): string | null {
  const k = String(userRegion || '')
    .trim()
    .toLowerCase();
  const map: Record<string, string> = {
    delhi: 'NCT of Delhi',
    'new delhi': 'NCT of Delhi',
    noida: 'Uttar Pradesh',
    gurgaon: 'Haryana',
    gurugram: 'Haryana',
    lucknow: 'Uttar Pradesh',
    jaipur: 'Rajasthan',
    chandigarh: 'Chandigarh',
    amritsar: 'Punjab',
    ludhiana: 'Punjab',
    mumbai: 'Maharashtra',
    patna: 'Bihar',
    kolkata: 'West Bengal',
    bengaluru: 'Karnataka',
    bangalore: 'Karnataka',
  };
  return map[k] || null;
}

function recordMatchesUserRegion(r: OgdRecord, userRegion: string): boolean {
  const k = String(userRegion).trim().toLowerCase();
  const district = String(r.district || '').toLowerCase();
  const market = String(r.market || '').toLowerCase();
  if (k === 'noida' || k === 'greater noida') {
    return (
      district.includes('gautam') ||
      district.includes('gautam buddha') ||
      market.includes('noida') ||
      market.includes('greater noida') ||
      district.includes('gb nagar')
    );
  }
  if (k === 'delhi' || k === 'new delhi') {
    return String(r.state || '').toLowerCase().includes('nct of delhi') || district.includes('delhi');
  }
  if (k === 'gurgaon' || k === 'gurugram') {
    return district.includes('gurugram') || district.includes('gurgaon') || market.includes('gurgaon');
  }
  return true;
}

export function ogdCommodityFilterName(code: string): string {
  return String(code || '')
    .replace(/_/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

async function datastoreSearch(params: {
  apiKey: string;
  resourceId: string;
  filters: Record<string, string>;
  limit: number;
}): Promise<OgdRecord[]> {
  const body = {
    resource_id: params.resourceId,
    limit: params.limit,
    filters: params.filters,
  };
  const url = new URL(OGD_DATASTORE_SEARCH);
  url.searchParams.set('api-key', params.apiKey);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json: { success?: boolean; result?: { records?: OgdRecord[] }; error?: string } = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      return [];
    }
    if (!res.ok || json.success === false) {
      return [];
    }
    return json.result?.records || [];
  } finally {
    clearTimeout(t);
  }
}

/**
 * Fetches real mandi rows from data.gov.in and stores them. Returns how many were inserted.
 */
export async function ingestOgdMandiForUserRegions(prisma: PrismaClient, params: {
  apiKey: string;
  resourceId?: string;
  commodityId: string;
  commodityCode: string;
  userSourceRegion: string;
  userTargetRegion: string;
}): Promise<{ inserted: number; usedStates: string[] }> {
  const resourceId = params.resourceId || process.env.OGD_MANDI_RESOURCE_ID || DEFAULT_RESOURCE_ID;
  const comm = ogdCommodityFilterName(params.commodityCode);
  const usedStates: string[] = [];
  let inserted = 0;

  const runForRegion = async (userLabel: string) => {
    const st = userRegionToOgdState(userLabel);
    if (!st) return;
    usedStates.push(st);

    const baseFilters: Record<string, string> = {
      state: st,
      commodity: comm,
    };

    let records = await datastoreSearch({
      apiKey: params.apiKey,
      resourceId,
      filters: baseFilters,
      limit: 200,
    });

    if (records.length === 0) {
      records = await datastoreSearch({
        apiKey: params.apiKey,
        resourceId,
        filters: { state: st },
        limit: 400,
      });
      const needle = comm.toLowerCase();
      records = records.filter((r) => String(r.commodity || '').toLowerCase() === needle);
    }

    records = records.filter((r) => recordMatchesUserRegion(r, userLabel));
    if (records.length > 20) {
      records = records.slice(0, 20);
    }

    for (const r of records) {
      const minP = num(r.min_price);
      const maxP = num(r.max_price);
      const modalP = num(r.modal_price) || (minP && maxP ? (minP + maxP) / 2 : 0);
      if (!modalP) continue;

      const displayRegion = String(userLabel).trim() || st;
      const mName = String(r.market || 'Mandi').trim() || 'Mandi';
      const market =
        (await prisma.market.findFirst({
          where: { name: mName, region: { equals: displayRegion, mode: 'insensitive' } },
        })) ||
        (await prisma.market.create({
          data: { name: mName, region: displayRegion, type: 'MANDI' },
        }));

      await prisma.mandiPrice.create({
        data: {
          commodityId: params.commodityId,
          marketId: market.id,
          priceMin: minP,
          priceMax: maxP || minP,
          priceModal: modalP,
          observedAt: parseArrivalDate(r.arrival_date),
          source: 'ogd-agmarknet',
        },
      });
      inserted += 1;
    }
  };

  await runForRegion(params.userSourceRegion);
  await runForRegion(params.userTargetRegion);

  return { inserted, usedStates: [...new Set(usedStates)] };
}

export function isDataGovKeyConfigured(): boolean {
  return Boolean(String(process.env.DATA_GOV_IN_API_KEY || '').trim());
}
