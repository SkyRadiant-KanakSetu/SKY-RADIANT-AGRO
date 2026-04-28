import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { findOrCreateCommodity } from '../lib/commodity';
import { ingestOgdMandiForUserRegions, isDataGovKeyConfigured } from '../lib/ogdMandi';
import { authenticate, requireRole } from '../middleware/auth';

export const agroRouter = Router();
agroRouter.use(authenticate);

agroRouter.get('/commodities', async (_req, res, next) => {
  try {
    const rows = await prisma.commodity.findMany({ orderBy: { name: 'asc' } });
    res.json({ success: true, data: rows });
  } catch (e) {
    next(e);
  }
});

agroRouter.post('/commodities', async (req, res, next) => {
  try {
    const { code, name, category = 'vegetable', defaultShelfLifeDays = 7 } = req.body || {};
    if (!code || !name) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'code and name are required' } });
    }
    const row = await prisma.commodity.create({
      data: {
        code: String(code).trim().toUpperCase(),
        name: String(name).trim(),
        category: String(category).trim().toLowerCase(),
        defaultShelfLifeDays: Number(defaultShelfLifeDays),
      },
    });
    res.status(201).json({ success: true, data: row });
  } catch (e) {
    next(e);
  }
});

agroRouter.get('/markets', async (_req, res, next) => {
  try {
    const rows = await prisma.market.findMany({ orderBy: [{ region: 'asc' }, { name: 'asc' }] });
    res.json({ success: true, data: rows });
  } catch (e) {
    next(e);
  }
});

agroRouter.get('/mandi-prices', async (req, res, next) => {
  try {
    const commodityCode = String(req.query.commodityCode || '')
      .trim()
      .toUpperCase();
    const region = String(req.query.region || '').trim();
    const days = Math.max(1, Math.min(30, Number(req.query.days || 7)));
    const limit = Math.max(1, Math.min(500, Number(req.query.limit || 200)));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const rows = await prisma.mandiPrice.findMany({
      where: {
        observedAt: { gte: since },
        commodity: commodityCode ? { code: commodityCode } : undefined,
        market: region
          ? {
              region: {
                equals: region,
                mode: 'insensitive',
              },
            }
          : undefined,
      },
      include: {
        commodity: { select: { code: true, name: true } },
        market: { select: { name: true, region: true, type: true } },
      },
      orderBy: { observedAt: 'desc' },
      take: limit,
    });

    res.json({ success: true, data: rows });
  } catch (e) {
    next(e);
  }
});

agroRouter.post('/markets', async (req, res, next) => {
  try {
    const { name, region, type = 'MANDI' } = req.body || {};
    if (!name || !region) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'name and region are required' } });
    }
    const row = await prisma.market.create({
      data: {
        name: String(name),
        region: String(region),
        type: String(type).toUpperCase() as any,
      },
    });
    res.status(201).json({ success: true, data: row });
  } catch (e) {
    next(e);
  }
});

agroRouter.post('/ingest/mandi-prices', requireRole('ADMIN', 'OPS'), async (req, res, next) => {
  try {
    const { commodityCode, commodityName, category = 'vegetable', marketName, region, priceMin, priceMax, priceModal, observedAt, source = 'manual' } = req.body || {};
    if (!commodityCode || !marketName || !region) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'commodityCode, marketName and region are required' } });
    }

    const code = String(commodityCode).trim().toUpperCase();
    const commodity = await prisma.commodity.upsert({
      where: { code },
      create: {
        code,
        name: String(commodityName || code),
        category: String(category).trim().toLowerCase(),
        defaultShelfLifeDays: 7,
      },
      update: {
        name: String(commodityName || code),
        category: String(category).trim().toLowerCase(),
      },
    });

    const market = await prisma.market.findFirst({
      where: { name: String(marketName), region: String(region) },
    }) || await prisma.market.create({
      data: { name: String(marketName), region: String(region), type: 'MANDI' },
    });

    const row = await prisma.mandiPrice.create({
      data: {
        commodityId: commodity.id,
        marketId: market.id,
        priceMin: Number(priceMin),
        priceMax: Number(priceMax),
        priceModal: Number(priceModal),
        observedAt: observedAt ? new Date(observedAt) : new Date(),
        source: String(source),
      },
      include: { commodity: { select: { code: true, name: true } }, market: { select: { name: true, region: true } } },
    });
    res.status(201).json({ success: true, data: row });
  } catch (e) {
    next(e);
  }
});

agroRouter.post('/ingest/weather', requireRole('ADMIN', 'OPS'), async (req, res, next) => {
  try {
    const { region, forecastDate, maxTempC, minTempC, humidityPct, rainfallMm, riskLevel, source = 'manual' } = req.body || {};
    if (!region || !forecastDate) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'region and forecastDate are required' } });
    }

    const inferRisk = () => {
      if (riskLevel) return String(riskLevel).toUpperCase();
      const rain = Number(rainfallMm || 0);
      const temp = Number(maxTempC || 0);
      const hum = Number(humidityPct || 0);
      if (rain >= 20 || (temp >= 40 && hum >= 80)) return 'HIGH';
      if (rain >= 8 || temp >= 35 || hum >= 75) return 'MEDIUM';
      return 'LOW';
    };

    const row = await prisma.weatherSnapshot.create({
      data: {
        region: String(region),
        forecastDate: new Date(forecastDate),
        maxTempC: maxTempC == null ? null : Number(maxTempC),
        minTempC: minTempC == null ? null : Number(minTempC),
        humidityPct: humidityPct == null ? null : Number(humidityPct),
        rainfallMm: rainfallMm == null ? null : Number(rainfallMm),
        riskLevel: inferRisk() as any,
        source: String(source),
      },
    });
    res.status(201).json({ success: true, data: row });
  } catch (e) {
    next(e);
  }
});

agroRouter.get('/intelligence/storage-plan', async (req, res, next) => {
  try {
    const commodityCode = String(req.query.commodityCode || '').trim().toUpperCase();
    if (!commodityCode) return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'commodityCode is required' } });

    const commodity = await prisma.commodity.findUnique({ where: { code: commodityCode } });
    if (!commodity) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Commodity not found' } });

    const profiles = await prisma.storageProfile.findMany({
      where: { commodityId: commodity.id },
      orderBy: { maxDays: 'desc' },
    });

    const best = profiles[0] || null;
    res.json({
      success: true,
      data: {
        commodity: { code: commodity.code, name: commodity.name },
        recommendation: best
          ? {
              mode: best.mode.toLowerCase(),
              maxDays: best.maxDays,
              conditions: `${best.tempRange || 'N/A'}; ${best.humidityRange || 'N/A'}`,
            }
          : {
              mode: commodity.defaultShelfLifeDays <= 5 ? 'cold' : 'dry',
              maxDays: commodity.defaultShelfLifeDays,
              conditions: commodity.defaultShelfLifeDays <= 5 ? '8-12C; 85-90% RH' : 'cool and dry',
            },
      },
    });
  } catch (e) {
    next(e);
  }
});

async function fetchOpenMeteoSnapshot(region: string) {
  const regionCoords: Record<string, { latitude: number; longitude: number }> = {
    delhi: { latitude: 28.6139, longitude: 77.209 },
    noida: { latitude: 28.5355, longitude: 77.391 },
    gurgaon: { latitude: 28.4595, longitude: 77.0266 },
    lucknow: { latitude: 26.8467, longitude: 80.9462 },
    jaipur: { latitude: 26.9124, longitude: 75.7873 },
    chandigarh: { latitude: 30.7333, longitude: 76.7794 },
    amritsar: { latitude: 31.634, longitude: 74.8723 },
  };

  const key = String(region || '').trim().toLowerCase();
  const coords = regionCoords[key];
  if (!coords) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.latitude}&longitude=${coords.longitude}&current=temperature_2m,relative_humidity_2m,precipitation`;
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    const json: any = await response.json();
    const current = json?.current;
    if (!current) return null;
    return {
      region,
      tempC: current.temperature_2m ?? null,
      humidityPct: current.relative_humidity_2m ?? null,
      rainfallMm: current.precipitation ?? null,
      source: 'open-meteo',
      observedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function pseudoCommodityBasePrice(code: string) {
  const clean = String(code || '').toUpperCase();
  const sum = clean.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return 14 + (sum % 18);
}

function regionOffset(region: string) {
  const key = String(region || '').trim().toLowerCase();
  const map: Record<string, number> = {
    delhi: 0.6,
    noida: 1.2,
    gurgaon: 1.1,
    lucknow: 0.9,
    jaipur: 0.8,
    chandigarh: 1.0,
    amritsar: 0.7,
  };
  return map[key] ?? 0.75;
}

async function ensureMandiBootstrapData(params: {
  commodityId: string;
  commodityCode: string;
  sourceRegion: string;
  targetRegion: string;
}) {
  const { commodityId, commodityCode, sourceRegion, targetRegion } = params;
  const [sourceExisting, targetExisting] = await Promise.all([
    prisma.mandiPrice.count({
      where: {
        commodityId,
        market: { region: { equals: sourceRegion, mode: 'insensitive' } },
      },
    }),
    prisma.mandiPrice.count({
      where: {
        commodityId,
        market: { region: { equals: targetRegion, mode: 'insensitive' } },
      },
    }),
  ]);
  if (sourceExisting > 0 && targetExisting > 0) return false;

  const [sourceMarket, targetMarket] = await Promise.all([
    prisma.market.findFirst({
      where: { region: { equals: sourceRegion, mode: 'insensitive' }, type: 'MANDI' },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.market.findFirst({
      where: { region: { equals: targetRegion, mode: 'insensitive' }, type: 'MANDI' },
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  const srcMarket =
    sourceMarket ||
    (await prisma.market.create({
      data: { name: `${sourceRegion} Mandi`, region: sourceRegion, type: 'MANDI' },
    }));
  const dstMarket =
    targetMarket ||
    (await prisma.market.create({
      data: { name: `${targetRegion} Mandi`, region: targetRegion, type: 'MANDI' },
    }));

  const base = pseudoCommodityBasePrice(commodityCode);
  const srcShift = regionOffset(sourceRegion);
  const dstShift = regionOffset(targetRegion);
  const now = Date.now();
  const rows: Array<{
    commodityId: string;
    marketId: string;
    priceMin: number;
    priceMax: number;
    priceModal: number;
    observedAt: Date;
    source: string;
  }> = [];

  for (let i = 0; i < 8; i += 1) {
    rows.push({
      commodityId,
      marketId: srcMarket.id,
      priceMin: Number((base + srcShift - 2 + i * 0.15).toFixed(2)),
      priceMax: Number((base + srcShift + 4 + i * 0.18).toFixed(2)),
      priceModal: Number((base + srcShift + i * 0.16).toFixed(2)),
      observedAt: new Date(now - i * 60 * 60 * 1000),
      source: 'auto-bootstrap',
    });
    rows.push({
      commodityId,
      marketId: dstMarket.id,
      priceMin: Number((base + dstShift - 1 + i * 0.16).toFixed(2)),
      priceMax: Number((base + dstShift + 5 + i * 0.2).toFixed(2)),
      priceModal: Number((base + dstShift + 1 + i * 0.18).toFixed(2)),
      observedAt: new Date(now - i * 60 * 60 * 1000),
      source: 'synthetic-demo',
    });
  }
  await prisma.mandiPrice.createMany({ data: rows });
  return true;
}

function syntheticMandiAllowed() {
  const v = process.env.ENABLE_SYNTHETIC_MANDI_BOOTSTRAP;
  if (v === undefined || v === '') return true;
  const s = String(v).toLowerCase();
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

type MandiRowSource = { source: string };

function dataSourceFromMandiRows(
  rows: MandiRowSource[],
  usedCrossRegionFallback: boolean
): 'ogd-agmarknet' | 'synthetic-demo' | 'cached' | 'cache-fallback' | 'mixed' {
  if (rows.length === 0) return 'cache-fallback';
  const isOgd = (s: string) => s === 'ogd-agmarknet' || s === 'manual' || s === 'seed-live';
  const isDemo = (s: string) => s === 'synthetic-demo' || s === 'auto-bootstrap';
  const hasOgd = rows.some((r) => isOgd(String(r.source || '')));
  const hasDemo = rows.some((r) => isDemo(String(r.source || '')));
  if (hasOgd && hasDemo) return 'mixed';
  if (hasOgd) return 'ogd-agmarknet';
  if (hasDemo) return 'synthetic-demo';
  if (usedCrossRegionFallback) return 'cache-fallback';
  return 'cached';
}

async function ensureMandiDataForRoute(params: {
  commodityId: string;
  commodityCode: string;
  sourceRegion: string;
  targetRegion: string;
  /** When true, skip OGD (caller already ran ingest this request). */
  skipOgd?: boolean;
}): Promise<{ usedOgd: boolean; usedSynthetic: boolean }> {
  const { commodityId, commodityCode, sourceRegion, targetRegion, skipOgd } = params;
  let usedOgd = false;
  let usedSynthetic = false;

  const key = String(process.env.DATA_GOV_IN_API_KEY || '').trim();
  if (key && !skipOgd) {
    try {
      const { inserted } = await ingestOgdMandiForUserRegions(prisma, {
        apiKey: key,
        commodityId,
        commodityCode,
        userSourceRegion: sourceRegion,
        userTargetRegion: targetRegion,
      });
      if (inserted > 0) usedOgd = true;
    } catch (e) {
      console.error('OGD mandi ingest failed', e);
    }
  }

  if (syntheticMandiAllowed()) {
    const did = await ensureMandiBootstrapData({
      commodityId,
      commodityCode,
      sourceRegion,
      targetRegion,
    });
    if (did) usedSynthetic = true;
  }

  return { usedOgd, usedSynthetic };
}

agroRouter.get('/intelligence/global-scan', async (req, res, next) => {
  try {
    const commodityCode = String(req.query.commodityCode || '')
      .trim()
      .toUpperCase();
    const sourceRegion = String(req.query.sourceRegion || '').trim();
    const targetMarket = String(req.query.targetMarket || '').trim();
    const hours = Math.max(6, Math.min(72, Number(req.query.hours || 48)));
    if (!commodityCode || !sourceRegion || !targetMarket) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_INPUT', message: 'commodityCode, sourceRegion, targetMarket are required' },
      });
    }

    const commodity = await findOrCreateCommodity(prisma, commodityCode);

    const key = String(process.env.DATA_GOV_IN_API_KEY || '').trim();
    if (key) {
      const any = await prisma.mandiPrice.count({ where: { commodityId: commodity.id } });
      if (any === 0) {
        try {
          await ingestOgdMandiForUserRegions(prisma, {
            apiKey: key,
            commodityId: commodity.id,
            commodityCode: commodity.code,
            userSourceRegion: sourceRegion,
            userTargetRegion: targetMarket,
          });
        } catch (e) {
          console.error('Global scan OGD preload failed', e);
        }
      }
    } else if (syntheticMandiAllowed()) {
      const any = await prisma.mandiPrice.count({ where: { commodityId: commodity.id } });
      if (any === 0) {
        await ensureMandiDataForRoute({
          commodityId: commodity.id,
          commodityCode: commodity.code,
          sourceRegion,
          targetRegion: targetMarket,
        });
      }
    }

    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const [sourcePrices, targetPrices, sourceWeather, targetWeather] = await Promise.all([
      prisma.mandiPrice.findMany({
        where: {
          commodityId: commodity.id,
          market: { region: { equals: sourceRegion, mode: 'insensitive' } },
          observedAt: { gte: since },
        },
        orderBy: { observedAt: 'desc' },
        take: 24,
      }),
      prisma.mandiPrice.findMany({
        where: {
          commodityId: commodity.id,
          market: { region: { equals: targetMarket, mode: 'insensitive' } },
          observedAt: { gte: since },
        },
        orderBy: { observedAt: 'desc' },
        take: 24,
      }),
      prisma.weatherSnapshot.findFirst({
        where: { region: sourceRegion },
        orderBy: { forecastDate: 'desc' },
      }),
      prisma.weatherSnapshot.findFirst({
        where: { region: targetMarket },
        orderBy: { forecastDate: 'desc' },
      }),
    ]);

    const sourceLiveWeather = await fetchOpenMeteoSnapshot(sourceRegion);
    const targetLiveWeather = await fetchOpenMeteoSnapshot(targetMarket);

    const classifyMandi = (rows: Array<{ source?: string }>) => {
      if (!rows.length) return { tier: 'none' as const, sources: [] as string[] };
      const sources = [...new Set(rows.map((r) => String(r.source || 'unknown')))];
      const isReal = (s: string) => s === 'ogd-agmarknet' || s === 'manual' || s === 'seed-live';
      const isDemo = (s: string) => s === 'synthetic-demo' || s === 'auto-bootstrap';
      const hasReal = rows.some((r) => isReal(String(r.source || '')));
      const hasDemo = rows.some((r) => isDemo(String(r.source || '')));
      let tier: 'real' | 'demo' | 'mixed' | 'unknown' = 'unknown';
      if (hasReal && hasDemo) tier = 'mixed';
      else if (hasReal) tier = 'real';
      else if (hasDemo) tier = 'demo';
      return { tier, sources };
    };

    const provSource = classifyMandi(sourcePrices);
    const provTarget = classifyMandi(targetPrices);
    const combinedRows = [...sourcePrices, ...targetPrices];
    const provAll = classifyMandi(combinedRows);
    const ogdOnServer = Boolean(String(process.env.DATA_GOV_IN_API_KEY || '').trim());
    let mandiDataQuality: 'REAL_AGMARKNET' | 'DEMO_SYNTHETIC' | 'MIXED' | 'INSUFFICIENT' = 'INSUFFICIENT';
    if (provAll.tier === 'real') mandiDataQuality = 'REAL_AGMARKNET';
    else if (provAll.tier === 'demo') mandiDataQuality = 'DEMO_SYNTHETIC';
    else if (provAll.tier === 'mixed') mandiDataQuality = 'MIXED';
    else if (provAll.tier === 'none') mandiDataQuality = 'INSUFFICIENT';
    const mandiHint =
      mandiDataQuality === 'REAL_AGMARKNET'
        ? 'Mandi modal/min/max in this window come from AGMARKNET (India) via data.gov.in — official open data.'
        : mandiDataQuality === 'DEMO_SYNTHETIC'
          ? 'Mandi prices here are demo/synthetic. Add DATA_GOV_IN_API_KEY on the server for real AGMARKNET data.'
          : mandiDataQuality === 'MIXED'
            ? 'Mix of real (AGMARKNET) and demo rows in the database. Prefer a clean OGD-only dataset for production.'
            : provAll.tier === 'none'
              ? 'No mandi rows in the selected time window — widen hours or ingest prices.'
              : 'Could not fully classify mandi row sources.';

    const sourceModal =
      sourcePrices.length > 0
        ? sourcePrices.reduce((acc: number, row: { priceModal: unknown }) => acc + Number(row.priceModal), 0) / sourcePrices.length
        : null;
    const targetModal =
      targetPrices.length > 0
        ? targetPrices.reduce((acc: number, row: { priceModal: unknown }) => acc + Number(row.priceModal), 0) / targetPrices.length
        : null;
    const avgLogisticsPerKg = 0.6;

    const grossSpread = sourceModal != null && targetModal != null ? targetModal - sourceModal : null;
    const netSpread = grossSpread != null ? grossSpread - avgLogisticsPerKg : null;
    const sourceRisk = String(sourceWeather?.riskLevel || 'MEDIUM');
    const targetRisk = String(targetWeather?.riskLevel || 'MEDIUM');
    const weatherRiskBoost = sourceRisk === 'HIGH' || targetRisk === 'HIGH' ? 0.15 : sourceRisk === 'MEDIUM' || targetRisk === 'MEDIUM' ? 0.08 : 0.03;

    const confidenceBase = netSpread == null ? 0.45 : netSpread > 2 ? 0.8 : netSpread > 1 ? 0.67 : netSpread > 0.4 ? 0.58 : 0.42;
    const confidence = Math.max(0.2, Math.min(0.95, confidenceBase - weatherRiskBoost));
    const action = netSpread == null ? 'HOLD' : netSpread > 0.8 ? 'BUY' : netSpread < -0.2 ? 'SELL' : 'HOLD';

    res.json({
      success: true,
      data: {
        commodity: { code: commodity.code, name: commodity.name },
        sourceRegion,
        targetMarket,
        windowHours: hours,
        dataProvenance: {
          mandiDataQuality,
          serverHasDataGovInKey: ogdOnServer,
          sourceRows: sourcePrices.length,
          targetRows: targetPrices.length,
          uniqueSources: [...new Set(combinedRows.map((r) => String((r as { source?: string }).source || 'unknown')))],
          sourceSide: provSource,
          targetSide: provTarget,
          weatherLive: 'open-meteo (real-time forecast API)',
          hint: mandiHint,
        },
        signals: {
          priceSpread: {
            sourceModal,
            targetModal,
            grossSpread,
            avgLogisticsPerKg,
            netSpread,
          },
          weather: {
            sourceStored: sourceWeather,
            targetStored: targetWeather,
            sourceLive: sourceLiveWeather,
            targetLive: targetLiveWeather,
          },
          logisticsSamples: 0,
        },
        decision: {
          action,
          confidence,
          reasoning: [
            netSpread == null ? 'Insufficient spread data, fallback to HOLD bias' : `Net spread after logistics: ${netSpread.toFixed(2)} /kg`,
            `Weather risk profile: ${sourceRisk} (source), ${targetRisk} (target)`,
            `Time window analyzed: last ${hours} hours`,
          ],
        },
      },
    });
  } catch (e) {
    next(e);
  }
});

agroRouter.post('/quality-specs', requireRole('ADMIN', 'OPS'), async (req, res, next) => {
  try {
    const { commodityCode, grade = 'A', parameter, minValue, maxValue, checklistNote } = req.body || {};
    if (!commodityCode || !parameter) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'commodityCode and parameter are required' } });
    }
    const commodity = await prisma.commodity.findUnique({ where: { code: String(commodityCode).trim().toUpperCase() } });
    if (!commodity) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Commodity not found' } });

    const row = await prisma.qualitySpec.create({
      data: {
        commodityId: commodity.id,
        grade: String(grade).toUpperCase(),
        parameter: String(parameter),
        minValue: minValue ? String(minValue) : null,
        maxValue: maxValue ? String(maxValue) : null,
        checklistNote: checklistNote ? String(checklistNote) : null,
      },
    });
    res.status(201).json({ success: true, data: row });
  } catch (e) {
    next(e);
  }
});

agroRouter.post('/storage-profiles', requireRole('ADMIN', 'OPS'), async (req, res, next) => {
  try {
    const { commodityCode, mode = 'COLD', tempRange, humidityRange, maxDays, spoilageRiskNote } = req.body || {};
    if (!commodityCode || !maxDays) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'commodityCode and maxDays are required' } });
    }
    const commodity = await prisma.commodity.findUnique({ where: { code: String(commodityCode).trim().toUpperCase() } });
    if (!commodity) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Commodity not found' } });

    const row = await prisma.storageProfile.create({
      data: {
        commodityId: commodity.id,
        mode: String(mode).toUpperCase() as any,
        tempRange: tempRange ? String(tempRange) : null,
        humidityRange: humidityRange ? String(humidityRange) : null,
        maxDays: Number(maxDays),
        spoilageRiskNote: spoilageRiskNote ? String(spoilageRiskNote) : null,
      },
    });
    res.status(201).json({ success: true, data: row });
  } catch (e) {
    next(e);
  }
});

agroRouter.post('/recommendations/generate', async (req, res, next) => {
  try {
    const { commodityCode, sourceRegion, targetMarket, quantityTons = 1 } = req.body || {};
    if (!commodityCode || !sourceRegion || !targetMarket) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_INPUT', message: 'commodityCode, sourceRegion, targetMarket are required' },
      });
    }

    const commodity = await findOrCreateCommodity(prisma, String(commodityCode));

    const normalizedSourceRegion = String(sourceRegion).trim();
    const normalizedTargetMarket = String(targetMarket).trim();

    const dataGovKey = String(process.env.DATA_GOV_IN_API_KEY || '').trim();
    if (dataGovKey) {
      try {
        await ingestOgdMandiForUserRegions(prisma, {
          apiKey: dataGovKey,
          commodityId: commodity.id,
          commodityCode: commodity.code,
          userSourceRegion: normalizedSourceRegion,
          userTargetRegion: normalizedTargetMarket,
        });
      } catch (e) {
        console.error('OGD mandi ingest (generate) failed', e);
      }
    }

    let prices = await prisma.mandiPrice.findMany({
      where: {
        commodityId: commodity.id,
        market: {
          region: {
            equals: normalizedSourceRegion,
            mode: 'insensitive',
          },
        },
      },
      orderBy: { observedAt: 'desc' },
      take: 8,
    });

    if (!prices.length) {
      await ensureMandiDataForRoute({
        commodityId: commodity.id,
        commodityCode: commodity.code,
        sourceRegion: normalizedSourceRegion,
        targetRegion: normalizedTargetMarket,
        skipOgd: Boolean(dataGovKey),
      });
      prices = await prisma.mandiPrice.findMany({
        where: {
          commodityId: commodity.id,
          market: {
            region: {
              equals: normalizedSourceRegion,
              mode: 'insensitive',
            },
          },
        },
        orderBy: { observedAt: 'desc' },
        take: 8,
      });
    }

    const fallbackPrices =
      prices.length > 0
        ? []
        : await prisma.mandiPrice.findMany({
            where: { commodityId: commodity.id },
            orderBy: { observedAt: 'desc' },
            take: 8,
          });
    const effectivePrices = prices.length ? prices : fallbackPrices;
    if (!effectivePrices.length) {
      const msg = isDataGovKeyConfigured()
        ? 'No mandi price rows could be loaded for this commodity/region. Verify OGD mapping or try another region, or set ENABLE_SYNTHETIC_MANDI_BOOTSTRAP=true for demo-only data.'
        : 'No mandi price data. Set DATA_GOV_IN_API_KEY on the server for real AGMARKNET (data.gov.in) prices, or set ENABLE_SYNTHETIC_MANDI_BOOTSTRAP=true for demo-only data.';
      return res.status(503).json({
        success: false,
        error: { code: 'NO_PRICE_DATA', message: msg },
      });
    }

    const latest = Number(effectivePrices[0].priceModal);
    const average =
      effectivePrices.reduce((acc: number, p: { priceModal: unknown }) => acc + Number(p.priceModal), 0) /
      effectivePrices.length;
    const fallbackPenalty = prices.length ? 0 : 0.15;
    const confidence = Math.max(0.2, Math.min(0.95, 0.55 + (average - latest) / Math.max(average, 1) - fallbackPenalty));
    const action = confidence > 0.62 ? 'BUY' : confidence < 0.42 ? 'SELL' : 'HOLD';

    const buy = latest;
    const sell = latest * (1 + 0.08 + confidence * 0.08);
    const marginMin = Math.max(0, sell - buy - 0.6);
    const marginMax = Math.max(marginMin, sell - buy + 0.9);
    const validUntil = new Date(Date.now() + 6 * 60 * 60 * 1000);

    const usedCrossRegionFallback = !prices.length && effectivePrices.length > 0;
    const dataSource: 'ogd-agmarknet' | 'synthetic-demo' | 'cached' | 'cache-fallback' | 'mixed' = dataSourceFromMandiRows(
      effectivePrices,
      usedCrossRegionFallback
    );

    const recommendation = await prisma.recommendation.create({
      data: {
        commodityId: commodity.id,
        sourceRegion: normalizedSourceRegion,
        targetMarket: normalizedTargetMarket,
        action: action as any,
        confidence,
        expectedMarginMin: marginMin,
        expectedMarginMax: marginMax,
        riskFlags: ['Weather and lane disruption may affect realization'],
        assumptions:
          dataSource === 'ogd-agmarknet'
            ? ['Mandi modal/min/max from India Open Data (AGMARKNET via data.gov.in)']
            : dataSource === 'mixed'
              ? ['Some mandi rows from AGMARKNET and some from demo/synthetic; prefer ENABLE_SYNTHETIC_MANDI_BOOTSTRAP=false in production for cleaner provenance']
              : dataSource === 'synthetic-demo'
                ? ['Demo-only synthetic prices — not real market data; disable ENABLE_SYNTHETIC_MANDI_BOOTSTRAP for production']
                : prices.length
                  ? ['Based on latest 8 mandi entries for source region']
                  : ['Fell back to latest commodity prices across all regions in database'],
        payload: {
          commodity: commodity.code,
          quantityTons: Number(quantityTons),
          dataSource,
          targetBuyRangePerKg: `${(buy * 0.98).toFixed(2)}-${(buy * 1.02).toFixed(2)}`,
          targetSellRangePerKg: `${(sell * 0.97).toFixed(2)}-${(sell * 1.03).toFixed(2)}`,
        },
        validUntil,
        createdByAgent: 'sky-radiant-master-agent',
      },
    });

    res.status(201).json({ success: true, data: recommendation });
  } catch (e) {
    next(e);
  }
});

agroRouter.get('/recommendations', async (req, res, next) => {
  try {
    const limit = Math.min(100, Number(req.query.limit || 20));
    const rows = await prisma.recommendation.findMany({
      orderBy: { createdAt: 'desc' },
      include: { commodity: { select: { code: true, name: true } } },
      take: limit,
    });
    res.json({ success: true, data: rows });
  } catch (e) {
    next(e);
  }
});

agroRouter.post('/recommendations/:id/outcome', requireRole('ADMIN', 'OPS'), async (req, res, next) => {
  try {
    const recommendationId = String(req.params.id);
    const existing = await prisma.recommendation.findUnique({ where: { id: recommendationId } });
    if (!existing) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Recommendation not found' } });

    const row = await prisma.recommendationOutcome.create({
      data: {
        recommendationId,
        executed: Boolean(req.body?.executed),
        executedQtyTons: req.body?.executedQtyTons == null ? null : Number(req.body.executedQtyTons),
        realizedBuyAvg: req.body?.realizedBuyAvg == null ? null : Number(req.body.realizedBuyAvg),
        realizedSellAvg: req.body?.realizedSellAvg == null ? null : Number(req.body.realizedSellAvg),
        realizedMargin: req.body?.realizedMargin == null ? null : Number(req.body.realizedMargin),
        spoilagePct: req.body?.spoilagePct == null ? null : Number(req.body.spoilagePct),
        notes: req.body?.notes ? String(req.body.notes) : null,
      },
    });
    res.status(201).json({ success: true, data: row });
  } catch (e) {
    next(e);
  }
});

agroRouter.post('/seo/jobs', requireRole('ADMIN', 'OPS'), async (req, res, next) => {
  try {
    const { topic, targetPersona, primaryKeyword, secondaryKeywords = [] } = req.body || {};
    if (!topic || !targetPersona || !primaryKeyword) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'topic, targetPersona, primaryKeyword are required' } });
    }
    const row = await prisma.seoContentJob.create({
      data: {
        topic: String(topic),
        targetPersona: String(targetPersona),
        primaryKeyword: String(primaryKeyword),
        secondaryKeywords,
      },
    });
    res.status(201).json({ success: true, data: row });
  } catch (e) {
    next(e);
  }
});

agroRouter.get('/seo/jobs', async (req, res, next) => {
  try {
    const limit = Math.min(100, Number(req.query.limit || 20));
    const rows = await prisma.seoContentJob.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    res.json({ success: true, data: rows });
  } catch (e) {
    next(e);
  }
});
